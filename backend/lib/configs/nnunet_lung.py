import os
from monailabel.interfaces.config import TaskConfig
from lib.infers.nnunet import NNUNet

class NNUNetLung(TaskConfig):
    def init(self, name, model_dir, conf, planner, **kwargs):
        super().init(name, model_dir, conf, planner, **kwargs) 
        self.labels = {"lung": 1}
        self.label_colors = {"lung": [240, 0, 180]}        # background is implicit (0)
        self.model_folder = os.path.join(
            model_dir, "nnUNet_weights/Lung")

    def infer(self) -> dict:
        return {self.name: NNUNet(self.model_folder, labels=self.labels, label_colors=self.label_colors,
                                  preprocess=True)}  # trained on 1 mm preprocessed scans

    def trainer(self):
        return None