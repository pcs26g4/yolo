from fastapi import APIRouter, Response, Query
from fastapi.responses import StreamingResponse
import cv2
import threading
import time
import sys
import logging
import asyncio
from collections import deque
import json
import os
import uuid
from pathlib import Path

from yolo_service import get_yolo_service
from database import SessionLocal
from crud import save_image

logger = logging.getLogger("yolo-live")
logger.setLevel(logging.INFO)

camera_lock = threading.Lock()
router = APIRouter(prefix="/api/yolo", tags=["YOLO Live Camera"])

# Global state
camera = None
running = False

# ✅ Live camera location
live_location = {
    "latitude": None,
    "longitude": None
}

# Global log buffer for SSE
log_buffer = deque(maxlen=50)
log_cond = threading.Condition()

# Temp storage for captured live frames
LIVE_CAPTURE_DIR = Path("uploads/results/live")
LIVE_CAPTURE_DIR.mkdir(parents=True, exist_ok=True)

def log_terminal(message: str, data: dict = None):
    """Prints to terminal and adds to SSE buffer."""
    # Always print to server terminal for debugging
    print(f"DEBUG: {message}")
    sys.stdout.flush()
    
    with log_cond:
        log_entry = {"message": message, "time": time.time()}
        if data:
            log_entry.update(data)
        log_buffer.append(log_entry)
        # We don't really use notify since we poll in sse_logs, but it's good practice
        log_cond.notify_all()


from app_utils.constants import AUTHORITY_MAP

def generate_frames():
    global running, camera

    yolo = get_yolo_service()
    frame_id = 0
    prev_time = time.time()
    
    # 🔵 Initial log to indicate detection engine is starting
    log_terminal("🚀 Started Detection ...")

    while True:
        try:
            with camera_lock:
                if not running:
                    break
                if camera is None or not camera.isOpened():
                    break
                success, frame = camera.read()

            if not success:
                time.sleep(0.01)
                continue

            frame_id += 1

            # ----------------------------
            # YOLO DETECTION PER FRAME
            # ----------------------------
            detections, annotated = yolo.detect_image(frame)

            now = time.time()
            fps = 1 / (now - prev_time) if (now - prev_time) > 0 else 0
            prev_time = now

            # ----------------------------
            # 🔥 DETAILED LOGGING & AUTO-STOP
            # ----------------------------
            
            # Check for VALID detections (must be in AUTHORITY_MAP)
            valid_detections = []
            if detections:
                for det in detections:
                    # Normalize class name to match AUTHORITY_MAP keys
                    norm_class = det["class_name"].lower().replace(" ", "").replace("_", "").replace("-", "")
                    
                    # Handle common mappings manually if needed (though service.py does some)
                    if norm_class in ["pothole"]: norm_class = "pathholes"
                    if norm_class in ["streetdebris"]: norm_class = "streetdebris"
                    
                    if norm_class in AUTHORITY_MAP:
                        valid_detections.append(det)

            if valid_detections:
                # ✅ USE LOCATION
                lat = live_location["latitude"]
                lon = live_location["longitude"]
                
                det_names = [d["class_name"] for d in valid_detections]
                log_terminal(
                    f"⚠️ Deviation Detected ({', '.join(det_names)})! Saving frame and stopping camera...",
                    data={"latitude": lat, "longitude": lon}
                )
                
                # Stop the camera and vision thread immediately
                with camera_lock:
                    running = False
                    if camera:
                        camera.release()
                        camera = None
                
                # Encode and log the final frame
                ret, buffer = cv2.imencode(".jpg", annotated)
                if ret:
                    frame_stream = buffer.tobytes()
                    
                    # Yield the final frame
                    yield (
                        b"--frame\r\n"
                        b"Content-Type: image/jpeg\r\n\r\n" +
                        frame_stream +
                        b"\r\n"
                    )
                
                # Save to database (optional but recommended since the user said "save image")
                # We'll at least notify the frontend that a capture is ready
                unique_id = uuid.uuid4().hex[:8]
                filename = f"live_capture_{unique_id}.png"
                filepath = LIVE_CAPTURE_DIR / filename
                
                # IMPORTANT: Save CLEAN frame for re-analysis, not annotated
                # Use PNG to avoid compression artifacts lowering confidence on re-check
                cv2.imwrite(str(filepath), frame)
                
                # ----------------------------
                # 💾 SAVE TO DATABASE - DISABLED (Let Frontend Handle Registration)
                # ----------------------------
                # We disable auto-save here to prevent duplicates when the user clicks "Register Complaint"
                # The "Proceed to Analysis" flow will handle the actual ticket creation using the captured frame.
                """
                try:
                    from services.complaint_service import create_complaint_workflow
                    
                    with SessionLocal() as db:
                        primary_det = valid_detections[0]
                        issue_type = primary_det["class_name"]
                        confidence = primary_det["confidence"]

                        result = create_complaint_workflow(
                            db=db,
                            lat=lat,
                            lon=lon,
                            issue_type=issue_type,
                            image_bytes=buffer.tobytes(),
                            content_type="image/jpeg",
                            media_type="live_capture",
                            file_name=filename,
                            check_duplicates=False, # Live capture might be spammy, but we want to capture deviations. Maybe True? User said "save image".
                            authority_map=AUTHORITY_MAP
                        )
                        
                        if result["status"] == "success":
                            ticket = result["ticket"]
                            sub = result["sub_ticket"]
                            log_terminal(f"💾 Saved to DB: Ticket {ticket.ticket_id} | Sub {sub.sub_id}")
                        else:
                            log_terminal(f"⚠️ Not saved: {result.get('message')}")

                except Exception as e:
                    log_terminal(f"❌ Database Error: {e}")
                """


                log_terminal(
                    f"✅ Frame saved successfully as {filename}",
                    data={
                        "capture_filename": filename,
                        "latitude": lat,
                        "longitude": lon
                    }
                )
                log_terminal("🛑 Detection stopped.")
                break
            else:
                # Log status every 2 seconds if nothing found to show it's alive
                if frame_id % 60 == 0:
                    log_terminal(f"Monitoring... (No deviations found) | FPS: {fps:.2f}")

            ret, buffer = cv2.imencode(".jpg", annotated)
            if not ret:
                continue
            frame_stream = buffer.tobytes()

            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n" +
                frame_stream +
                b"\r\n"
            )
            
            # Tiny sleep to allow thread switching
            time.sleep(0.001)
            
        except Exception as e:
            log_terminal(f"Error in Vision Thread: {str(e)}")
            time.sleep(0.1)
            continue


@router.get("/live")
async def start_live(
    latitude: float = Query(None),
    longitude: float = Query(None)
):
    global camera, running, live_location

    with camera_lock:
        if not running:
            # Clear old logs when starting a fresh stream
            with log_cond:
                log_buffer.clear()
            
            running = True
            camera = cv2.VideoCapture(0)
            if not camera.isOpened():
                running = False
                return Response("Unable to open webcam", status_code=500)

            # ✅ STORE LOCATION
            live_location["latitude"] = latitude
            live_location["longitude"] = longitude

    log_terminal(
        "🔵 Camera Stream Activated",
        data={"latitude": latitude, "longitude": longitude}
    )
    return StreamingResponse(generate_frames(),
                             media_type="multipart/x-mixed-replace; boundary=frame")


@router.get("/events")
async def sse_logs():
    """Stream detection logs to frontend via SSE."""
    async def event_generator():
        # Start by sending any existing logs in the buffer (history)
        with log_cond:
            initial_logs = list(log_buffer)
            for log in initial_logs:
                yield f"data: {json.dumps(log)}\n\n"
        
        last_log_time = time.time()
        heartbeat_count = 0
        
        while True:
            new_logs = []
            with log_cond:
                new_logs = [l for l in log_buffer if l["time"] > last_log_time]
            
            if new_logs:
                for log in new_logs:
                    yield f"data: {json.dumps(log)}\n\n"
                last_log_time = new_logs[-1]["time"]
            
            # Send a heartbeat every 5 seconds to keep connection alive
            heartbeat_count += 1
            if heartbeat_count % 50 == 0:
                yield f"data: {json.dumps({'message': 'HEARTBEAT', 'time': time.time(), 'heartbeat': True})}\n\n"
            
            await asyncio.sleep(0.1)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.get("/stop")
async def stop_camera():
    global camera, running

    with camera_lock:
        running = False
        if camera:
            try:
                camera.release()
            except:
                pass
            camera = None

    # ✅ CLEAR LOCATION
    live_location["latitude"] = None
    live_location["longitude"] = None

    # Clear logs when stopped so they don't persist to the next session
    with log_cond:
        log_buffer.clear()

    log_terminal("🔴 Camera Stream Deactivated")
    return {"status": "camera stopped"}


@router.get("/capture/{filename}")
async def get_live_capture(filename: str):
    """Serve a captured frame from the live session."""
    from fastapi.responses import FileResponse
    filepath = LIVE_CAPTURE_DIR / filename
    if not filepath.exists():
        return Response("Capture not found", status_code=404)
    return FileResponse(str(filepath))