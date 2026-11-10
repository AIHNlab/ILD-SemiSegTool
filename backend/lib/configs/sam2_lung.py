import os
from monailabel.interfaces.config import TaskConfig
from lib.infers.sam2_interactive import SAM2InteractiveInferTask

class SAM2Lung(TaskConfig):
    def init(self, name, model_dir, conf, planner, **kwargs):
        super().init(name, model_dir, conf, planner, **kwargs)
        self.labels = {"lung": 1}
        self.label_colors = {"lung": [128, 174, 128]}
        self.checkpoint_path = os.path.join(model_dir, "sam2/checkpoint_lung.pt")

    def infer(self) -> dict:
        if not os.path.exists(self.checkpoint_path):
            return {}
        return {self.name: SAM2InteractiveInferTask(
            self.checkpoint_path, labels=self.labels, label_colors=self.label_colors,
            description="SAM2 interactive lung segmentation — point/box/freehand prompt")}

    def trainer(self):
        return None
