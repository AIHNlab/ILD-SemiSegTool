import os
from monailabel.interfaces.config import TaskConfig
from lib.infers.sam2_interactive import SAM2InteractiveInferTask

class SAM2ILD(TaskConfig):
    def init(self, name, model_dir, conf, planner, **kwargs):
        super().init(name, model_dir, conf, planner, **kwargs)
        self.labels = {
            "healthy": 1, "ggo": 2, "reticulation": 3, "consolidation": 4,
            "honeycombing": 5, "reticulation_ggo": 6, "bronchiectasis": 7,
            "emphysema": 8,
        }
        self.label_colors = {
            "healthy":          [ 76, 175,  80],   # green
            "ggo":              [255, 235,  59],   # yellow
            "reticulation":     [233,  30,  99],   # pink
            "consolidation":    [244,  67,  54],   # red
            "honeycombing":     [255, 152,   0],   # orange
            "reticulation_ggo": [  0, 188, 212],   # cyan
            "bronchiectasis":   [ 33, 150, 243],   # blue
            "emphysema":        [156,  39, 176],   # purple
        }
        self.checkpoint_path = os.path.join(model_dir, "sam2/checkpoint_ild.pt")

    def infer(self) -> dict:
        if not os.path.exists(self.checkpoint_path):
            return {}
        return {self.name: SAM2InteractiveInferTask(
            self.checkpoint_path, labels=self.labels, label_colors=self.label_colors,
            description="SAM2 interactive ILD segmentation — point/box/freehand prompt")}

    def trainer(self):
        return None
