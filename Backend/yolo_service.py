"""
YOLOv5 Detection Service
Handles model loading and inference for object detection
"""
import sys
from pathlib import Path
from typing import List, Tuple, Optional

# Add YOLOv5 to path
YOLO_ROOT = Path(__file__).parent.parent.parent / "yolov_5" / "yolov5"
YOLO_ROOT = YOLO_ROOT.resolve()

# Lazy imports - only import when actually needed
def _import_dependencies():
    """Import all required dependencies"""
    try:
        import torch
        import cv2
        import numpy as np
        
        # Use importlib to import from YOLOv5 directory, avoiding conflicts with local models.py
        import importlib
        import importlib.util
        
        # Add YOLOv5 root to path if not already there (must be first to take precedence)
        yolo_path = str(YOLO_ROOT)
        if yolo_path not in sys.path:
            sys.path.insert(0, yolo_path)
        
        # Temporarily remove Backend directory from path to avoid local models.py conflict
        backend_path = str(Path(__file__).parent)
        backend_in_path = backend_path in sys.path
        if backend_in_path:
            sys.path.remove(backend_path)
        
        # Aggressively clear cached modules that conflict with YOLOv5
        # This prevents importing from Backend/utils or Backend/models
        modules_to_remove = []
        for mod_name in list(sys.modules.keys()):
            # Remove any modules from Backend that conflict
            if mod_name in ['models', 'utils'] or mod_name.startswith(('models.', 'utils.')):
                mod = sys.modules.get(mod_name)
                if mod:
                    # Check if it's from Backend directory
                    if hasattr(mod, '__file__') and mod.__file__:
                        if backend_path in str(mod.__file__):
                            modules_to_remove.append(mod_name)
                    # Also check if it's a namespace package pointing to wrong location
                    elif backend_in_path and mod_name in ['models', 'utils']:
                        # Check if any submodule is from backend
                        has_backend_submod = any(
                            backend_path in str(getattr(sys.modules.get(k), '__file__', ''))
                            for k in sys.modules.keys()
                            if k.startswith(f'{mod_name}.')
                        )
                        if has_backend_submod:
                            modules_to_remove.append(mod_name)
        
        # Remove in reverse order (submodules first)
        for mod_name in sorted(modules_to_remove, reverse=True):
            if mod_name in sys.modules:
                del sys.modules[mod_name]
        
        try:
            # Clear utils module if it exists and is from wrong location
            # This ensures we import from YOLOv5/utils, not Backend/utils
            if 'utils' in sys.modules:
                utils_mod = sys.modules['utils']
                if hasattr(utils_mod, '__file__') and utils_mod.__file__:
                    if backend_path in str(utils_mod.__file__):
                        # Remove utils and all its submodules
                        utils_keys = [k for k in list(sys.modules.keys()) if k == 'utils' or k.startswith('utils.')]
                        for k in utils_keys:
                            if k in sys.modules:
                                del sys.modules[k]
            
            # Now do regular imports - they should find YOLOv5's modules
            # YOLOv5 path is first, Backend is removed, so imports will work correctly
            from models.common import DetectMultiBackend
            from utils.general import (
                check_img_size,
                non_max_suppression,
                scale_boxes,
                LOGGER,
            )
            from utils.augmentations import letterbox
            from utils.torch_utils import select_device
            from utils.dataloaders import LoadImages
        finally:
            # Restore Backend path if it was there
            if backend_in_path:
                sys.path.insert(0, backend_path)
        return {
            'torch': torch,
            'cv2': cv2,
            'np': np,
            'DetectMultiBackend': DetectMultiBackend,
            'check_img_size': check_img_size,
            'non_max_suppression': non_max_suppression,
            'scale_boxes': scale_boxes,
            'LOGGER': LOGGER,
            'letterbox': letterbox,
            'select_device': select_device,
            'LoadImages': LoadImages,
        }
    except ImportError as e:
        raise ImportError(
            f"Failed to import YOLOv5 dependencies. "
            f"Please install: pip install torch torchvision opencv-python numpy ultralytics. "
            f"Error: {e}"
        )


class YOLOv5Service:
    """Service for YOLOv5 object detection"""
    
    def __init__(
        self,
        weights_path: Optional[str] = None,
        device: str = "",
        img_size: int = 640,
        conf_threshold: float = 0.40,
        iou_threshold: float = 0.45,
    ):
        """
        Initialize YOLOv5 service
        
        Args:
            weights_path: Path to model weights file (.pt)
            device: Device to run inference on ('cpu', 'cuda', '0', etc.)
            img_size: Input image size for inference
            conf_threshold: Confidence threshold for detections
            iou_threshold: IoU threshold for NMS
        """
        # Import dependencies
        deps = _import_dependencies()
        self.torch = deps['torch']
        self.cv2 = deps['cv2']
        self.np = deps['np']
        self.DetectMultiBackend = deps['DetectMultiBackend']
        self.check_img_size = deps['check_img_size']
        self.non_max_suppression = deps['non_max_suppression']
        self.scale_boxes = deps['scale_boxes']
        self.LOGGER = deps['LOGGER']
        self.letterbox = deps['letterbox']
        self.select_device = deps['select_device']
        self.LoadImages = deps['LoadImages']
        
        self.device = self.select_device(device)
        self.img_size = img_size
        self.conf_threshold = conf_threshold
        self.iou_threshold = iou_threshold
        
        # Default weights paths
        custom_weights = YOLO_ROOT / "weights" / "best.pt"
        if not custom_weights.exists():
            custom_weights = YOLO_ROOT / "weights" / "best.onnx"
        
        default_weights = YOLO_ROOT / "yolov5s.pt"

        # If weights_path provided, use it. Otherwise try custom, then default.
        if weights_path:
            self.weights_path = Path(weights_path)
        elif custom_weights.exists():
            self.weights_path = custom_weights
        else:
            self.weights_path = default_weights

        if not self.weights_path.exists():
            raise FileNotFoundError(f"Model weights not found at {self.weights_path}")
        
        # Load main model
        self.model = self.DetectMultiBackend(
            str(self.weights_path),
            device=self.device,
            dnn=False,
            data=None,
            fp16=False
        )

        # Load Fallback COCO model if we are using custom weights
        self.fallback_model = None
        if self.weights_path != default_weights and default_weights.exists():
            try:
                self.fallback_model = self.DetectMultiBackend(
                    str(default_weights),
                    device=self.device,
                    dnn=False,
                    data=None,
                    fp16=False
                )
                self.LOGGER.info("✅ Fallback COCO model (yolov5s.pt) loaded successfully.")
                self.fallback_names = self.fallback_model.names
            except Exception as e:
                self.LOGGER.warning(f"⚠️ Could not load fallback model: {e}")
                self.fallback_names = None
        else:
            self.fallback_names = None
        
        # Get model info
        self.stride = self.model.stride
        self.names = self.model.names
        self.pt = self.model.pt
        
        # Check image size
        self.img_size = self.check_img_size(self.img_size, s=self.stride)
        
        # Warmup model
        imgsz = (1, 3, self.img_size, self.img_size) if isinstance(self.img_size, int) else (1, 3, *self.img_size)
        self.model.warmup(imgsz=imgsz)
        
        self.LOGGER.info(f"YOLOv5 model loaded from {weights_path}")
        self.LOGGER.info(f"Using device: {self.device}")
        self.LOGGER.info(f"Model classes: {self.names}")
    
    def detect(
        self,
        image_path: str | Path,
        save_annotated: bool = True,
        output_dir: Optional[str | Path] = None,
    ) -> Tuple[List[dict], any]:
        """
        Run detection on an image
        
        Args:
            image_path: Path to input image
            save_annotated: Whether to save annotated image
            output_dir: Directory to save annotated image
            
        Returns:
            Tuple of (detections list, annotated image array)
        """
        image_path = Path(image_path)
        if not image_path.exists():
            raise FileNotFoundError(f"Image not found: {image_path}")
        
        # Load image
        dataset = self.LoadImages(
            str(image_path),
            img_size=self.img_size,
            stride=self.stride,
            auto=self.pt
        )
        
        detections = []
        annotated_img = None
        
        for path, im, im0s, vid_cap, s in dataset:
            # Preprocess
            im = self.torch.from_numpy(im).to(self.device)
            im = im.half() if self.model.fp16 else im.float()
            im /= 255.0
            if len(im.shape) == 3:
                im = im[None]  # Add batch dimension
            
            # Inference
            pred = self.model(im, augment=False, visualize=False)
            
            # NMS
            pred = self.non_max_suppression(
                pred,
                self.conf_threshold,
                self.iou_threshold,
                classes=None,
                agnostic=False,
                max_det=1000
            )
            
            # Process predictions
            im0 = im0s.copy()
            gn = self.torch.tensor(im0.shape)[[1, 0, 1, 0]]  # normalization gain whwh
            
            for i, det in enumerate(pred):
                if len(det):
                    # Rescale boxes from img_size to im0 size
                    det[:, :4] = self.scale_boxes(im.shape[2:], det[:, :4], im0.shape).round()
                    
                    # Extract detections
                    for *xyxy, conf, cls in reversed(det):
                        x1, y1, x2, y2 = [float(x.item()) for x in xyxy]
                        confidence = float(conf.item())
                        class_id = int(cls.item())
                        class_name = self.names[class_id]
                        
                        detections.append({
                            "class_name": class_name,
                            "confidence": confidence,
                            "bbox": {
                                "x1": x1,
                                "y1": y1,
                                "x2": x2,
                                "y2": y2,
                            }
                        })
                        
                        # Draw bounding box on image
                        if save_annotated:
                            label = f"{class_name} {confidence:.2f}"
                            self.cv2.rectangle(im0, (int(x1), int(y1)), (int(x2), int(y2)), (0, 255, 0), 2)
                            self.cv2.putText(
                                im0,
                                label,
                                (int(x1), int(y1) - 10),
                                self.cv2.FONT_HERSHEY_SIMPLEX,
                                0.5,
                                (0, 255, 0),
                                2
                            )
            
            annotated_img = im0
        
        return detections, annotated_img
    
    def detect_image(
        self,
        im0: any,
        save_annotated: bool = True,
    ) -> Tuple[List[dict], any]:
        """
        Run detection on a numpy array (image)
        
        Args:
            im0: Input image as numpy array (BGR)
            save_annotated: Whether to return annotated image
            
        Returns:
            Tuple of (detections list, annotated image array)
        """
        if im0 is None:
            raise ValueError("Input image is None")
        
        # Use YOLOv5 preprocessing
        im = self.letterbox(im0, self.img_size, stride=self.stride, auto=self.pt)[0]
        im = im.transpose((2, 0, 1))[::-1]
        im = self.np.ascontiguousarray(im)
        
        # Convert to tensor
        im_tensor = self.torch.from_numpy(im).to(self.device).float()
        im_tensor /= 255.0
        if im_tensor.ndim == 3:
            im_tensor = im_tensor[None]
        
        # Inference
        self.LOGGER.info(f"Running inference on image with shape {im_tensor.shape}")
        pred = self.model(im_tensor, augment=False, visualize=False)
        self.LOGGER.info(f"Raw predictions count: {len(pred[0]) if len(pred) else 0}")
        
        # NMS
        pred = self.non_max_suppression(
            pred, self.conf_threshold, self.iou_threshold,
            classes=None, agnostic=False, max_det=1000
        )
        
        detections = []
        annotated_img = im0.copy()
        
        # Track which model was used
        using_fallback = False
        
        # 🔥 Fallback Logic: If no detections and fallback model exists, try it
        if (not pred or not any(len(d) for d in pred)) and self.fallback_model:
            self.LOGGER.info("No custom detections found. Trying fallback model...")
            using_fallback = True
            pred = self.fallback_model(im_tensor, augment=False, visualize=False)
            pred = self.non_max_suppression(
                pred, self.conf_threshold, self.iou_threshold,
                classes=None, agnostic=False, max_det=1000
            )

        if len(pred):
            for i, det in enumerate(pred):
                if det is not None and len(det) > 0:
                    det[:, :4] = self.scale_boxes(im_tensor.shape[2:], det[:, :4], im0.shape).round()
                    for *xyxy, conf, cls in reversed(det):
                        x1, y1, x2, y2 = [float(x.item()) for x in xyxy]
                        confidence = float(conf.item())
                        
                        # Use correct names list
                        current_names = self.fallback_names if using_fallback else self.names
                        class_name = current_names[int(cls)]
                        
                        self.LOGGER.info(f"NMS Result: {class_name} ({confidence:.2f})")

                        # 🧠 SMART MAPPING: Map COCO objects to municipal categories
                        # Garbage often looks like 'handbag', 'backpack', or 'bottle' to a standard model
                        if using_fallback:
                            if class_name in ['handbag', 'backpack', 'suitcase', 'bottle', 'cup']:
                                class_name = "garbage"
                            elif class_name in ['car', 'truck', 'bus'] and confidence < 0.4:
                                # Low confidence vehicles on road could be debris
                                class_name = "street_debris"

                        detections.append({
                            "class_name": class_name,
                            "confidence": confidence,
                            "bbox": {"x1": x1, "y1": y1, "x2": x2, "y2": y2}
                        })
                        
                        if save_annotated:
                            label = f"{class_name} {confidence:.2f}"
                            self.cv2.rectangle(annotated_img, (int(x1), int(y1)), (int(x2), int(y2)), (0, 255, 0), 2)
                            self.cv2.putText(annotated_img, label, (int(x1), int(y1) - 10),
                                            self.cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)
        
        return detections, annotated_img

    def detect_from_bytes(
        self,
        image_bytes: bytes,
        save_annotated: bool = True,
    ) -> Tuple[List[dict], any]:
        """Run detection on image bytes"""
        nparr = self.np.frombuffer(image_bytes, self.np.uint8)
        im0 = self.cv2.imdecode(nparr, self.cv2.IMREAD_COLOR)
        return self.detect_image(im0, save_annotated)
    
    def detect_video(
        self,
        video_path: str | Path,
        output_path: Optional[str | Path] = None,
        conf_threshold: Optional[float] = None,
    ) -> Tuple[str, List[dict], int]:
        """
        Run detection on a video file
        
        Args:
            video_path: Path to input video file
            output_path: Path to save annotated video (optional)
            conf_threshold: Confidence threshold (uses instance default if None)
            
        Returns:
            Tuple of (output_video_path, cumulative_detections, frames_processed)
        """
        import time
        start_time = time.time()
        
        video_path = Path(video_path)
        if not video_path.exists():
            raise FileNotFoundError(f"Video not found: {video_path}")
        
        # Use instance threshold or provided one
        conf_thresh = conf_threshold if conf_threshold is not None else self.conf_threshold
        
        # Set output path
        if output_path is None:
            output_path = video_path.parent / f"annotated_{video_path.name}"
        else:
            output_path = Path(output_path)
        
        # Load video
        cap = self.cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            raise ValueError(f"Failed to open video: {video_path}")
        
        # Get video properties
        fps = int(cap.get(self.cv2.CAP_PROP_FPS)) or 30
        width = int(cap.get(self.cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(self.cv2.CAP_PROP_FRAME_HEIGHT))
        total_frames = int(cap.get(self.cv2.CAP_PROP_FRAME_COUNT))
        
        self.LOGGER.info(f"Processing video: {width}x{height}, {fps} FPS, {total_frames} frames")
        
        # Create video writer - try 'avc1' for H.264 (web compatible)
        try:
            fourcc = self.cv2.VideoWriter_fourcc(*'avc1')
            out = self.cv2.VideoWriter(str(output_path), fourcc, fps, (width, height))
            if not out.isOpened():
                raise Exception("avc1 failed")
        except:
            # Fallback to mp4v if avc1 is not available
            fourcc = self.cv2.VideoWriter_fourcc(*'mp4v')
            out = self.cv2.VideoWriter(str(output_path), fourcc, fps, (width, height))
        
        frames_processed = 0
        cumulative_detections = []
        
        try:
            while True:
                ret, frame = cap.read()
                if not ret:
                    break
                
                # Preprocess frame
                im = self.letterbox(frame, self.img_size, stride=self.stride, auto=self.pt)[0]
                im = im.transpose((2, 0, 1))[::-1]  # HWC to CHW, BGR to RGB
                im = self.np.ascontiguousarray(im)
                
                # Convert to tensor
                im_tensor = self.torch.from_numpy(im).to(self.device)
                im_tensor = im_tensor.half() if self.model.fp16 else im_tensor.float()
                im_tensor /= 255.0
                if len(im_tensor.shape) == 3:
                    im_tensor = im_tensor[None]
                
                # Inference - Primary
                pred = self.model(im_tensor, augment=False, visualize=False)
                pred = self.non_max_suppression(
                    pred, conf_thresh, self.iou_threshold,
                    classes=None, agnostic=False, max_det=1000
                )
                
                using_fallback = False
                # Fallback Logic
                if (not pred or not any(len(d) for d in pred)) and self.fallback_model:
                    using_fallback = True
                    pred = self.fallback_model(im_tensor, augment=False, visualize=False)
                    pred = self.non_max_suppression(
                        pred, conf_thresh, self.iou_threshold,
                        classes=None, agnostic=False, max_det=1000
                    )

                # Process detections
                frame_detections_count = 0
                for det in pred:
                    if det is not None and len(det) > 0:
                        # Rescale boxes
                        det[:, :4] = self.scale_boxes(im_tensor.shape[2:], det[:, :4], frame.shape).round()
                        
                        # Use correct names list
                        current_names = self.fallback_names if using_fallback else self.names

                        # Draw bounding boxes
                        for *xyxy, conf, cls in reversed(det):
                            x1, y1, x2, y2 = [int(x.item()) for x in xyxy]
                            confidence = float(conf.item())
                            class_name = current_names[int(cls)]
                            
                            # 🧠 SMART MAPPING: Map COCO objects to municipal categories
                            if using_fallback:
                                if class_name in ['handbag', 'backpack', 'suitcase', 'bottle', 'cup']:
                                    class_name = "garbage"
                                elif class_name in ['car', 'truck', 'bus'] and confidence < 0.4:
                                    class_name = "street_debris"

                            cumulative_detections.append({
                                "class_name": class_name,
                                "confidence": confidence,
                                "frame": frames_processed
                            })

                            # Draw box
                            label = f"{class_name} {confidence:.2f}"
                            self.cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
                            self.cv2.putText(frame, label, (x1, y1 - 10),
                                            self.cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)
                            frame_detections_count += 1
                
                frames_processed += 1
                out.write(frame)
                
                if frames_processed % 30 == 0:
                    self.LOGGER.info(f"Processed {frames_processed}/{total_frames} frames")
        
        finally:
            cap.release()
            out.release()
        
        processing_time = time.time() - start_time
        self.LOGGER.info(f"Video processing complete: {frames_processed} frames, {len(cumulative_detections)} total detections, {processing_time:.2f}s")
        
        return str(output_path), cumulative_detections, frames_processed


# Global service instance (lazy loading)
_yolo_service: Optional[YOLOv5Service] = None


def get_yolo_service() -> YOLOv5Service:
    """Get or create YOLOv5 service instance"""
    global _yolo_service
    if _yolo_service is None:
        _yolo_service = YOLOv5Service()
    return _yolo_service