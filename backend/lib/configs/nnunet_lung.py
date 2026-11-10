import os
from monailabel.interfaces.config import TaskConfig
from lib.infers.nnunet import NNUNet

class NNUNetLung(TaskConfig):
    def init(self, name, model_dir, conf, planner, **kwargs):
        super().init(name, model_dir, conf, planner, **kwargs) 
        self.labels = {"lung": 1}
        self.label_colors = {"lung": [128, 174, 128]}        # background is implicit (0)
        self.model_folder = os.path.join(
            model_dir, "nnUNet_results/Dataset001_Lung/nnUNetTrainer__nnUNetPlans__3d_fullres")

    def infer(self) -> dict:
        return {self.name: NNUNet(self.model_folder, labels=self.labels, label_colors=self.label_colors)}

    def trainer(self):
        return None