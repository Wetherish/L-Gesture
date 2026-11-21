"""On-device face AI over SSH/SFTP; credentials come from environment variables."""

import time

from l_gesture.vendor.logiinsight.logiwebcam import LogiWebcamClient, AiStalenessMonitor


class FaceTracker:
    def __init__(self, ip="192.168.1.10", mesh=True):
        self.client = LogiWebcamClient(ip=ip)
        self.mesh = mesh
        self.monitor = AiStalenessMonitor()

    def __enter__(self):
        try:
            self.client.connect()
            if not self.client.set_ai_config(enable_face_detection=True, enable_face_mesh=self.mesh):
                raise RuntimeError("Could not configure the camera face AI")
            time.sleep(1)
            return self
        except BaseException:
            self.client.disconnect()
            raise

    def latest(self):
        """Return (SDK AI dictionary, optional staleness warning). Keep RGB reading."""
        data = self.client.get_latest_ai_data()
        return data, self.monitor.update(data)

    def __exit__(self, *_):
        self.client.disconnect()
