import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dictation_service import DictationService, REQUIRED_FILES, get_settings


class DictationModelsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        config = patch.dict(os.environ, {"STORAGE_DIR": temporary.name, "WHISPER_MODEL": "large-v3"})
        config.start()
        self.addCleanup(config.stop)
        get_settings.cache_clear()
        self.addCleanup(get_settings.cache_clear)
        with patch("dictation_service.WhisperAsr"):
            self.service = DictationService()

    @staticmethod
    def write_model(path: Path):
        path.mkdir(parents=True)
        for name in REQUIRED_FILES:
            (path / name).write_bytes(b"fixture")

    async def test_download_then_preload_saved_model(self):
        with patch("dictation_service.download_model", side_effect=lambda _name, output_dir: self.write_model(Path(output_dir))):
            await self.service.download("turbo")
        self.assertIsNone(self.service.active)
        self.assertTrue(self.service.status()["models"][0]["installed"])
        self.service.persist("turbo")
        with patch.object(self.service, "warm") as warm:
            await self.service.preload()
        warm.assert_called_once_with("turbo")
        self.assertEqual(self.service.active, "turbo")

    async def test_failed_activation_restores_previous_model_and_selection(self):
        self.service.active = "quality"
        self.service.persist("quality")
        with patch.object(self.service, "warm", side_effect=[RuntimeError("load failed"), None]) as warm:
            with self.assertLogs("dictation_service", level="ERROR"):
                await self.service.activate("turbo")
        self.assertEqual([call.args for call in warm.call_args_list], [("turbo",), ("quality",)])
        self.assertEqual(self.service.active, "quality")
        self.assertEqual(json.loads(self.service.selection.read_text(encoding="utf-8")), {"model": "quality"})


if __name__ == "__main__":
    unittest.main()
