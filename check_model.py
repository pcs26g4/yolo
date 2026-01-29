
import sys
from pathlib import Path

# Add YOLOv5 to path
YOLO_ROOT = Path("c:/Users/guest1/Downloads/MDMS/mdms/yolov_5/yolov5")
sys.path.append(str(YOLO_ROOT))

import torch
from models.common import DetectMultiBackend

weights_path = "c:/Users/guest1/Downloads/MDMS/mdms/yolov_5/yolov5/weights/last.pt"
device = torch.device("cpu")

try:
    model = DetectMultiBackend(weights_path, device=device)
    print(f"Classes: {model.names}")
except Exception as e:
    print(f"Error: {e}")
