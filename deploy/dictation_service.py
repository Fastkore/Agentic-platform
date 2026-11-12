"""Local Whisper service for Agent Platform, using the installed Faster Whisper environment."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
import wave
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from app.asr import WhisperAsr
from app.auth import verify_api_token
from app.config import get_settings
from faster_whisper.utils import download_model

ModelId = Literal["turbo", "quality"]
CATALOG = {"turbo": "large-v3-turbo", "quality": "large-v3"}
REQUIRED_FILES = ("config.json", "model.bin", "tokenizer.json")
MAX_AUDIO = 44 + 62 * 16_000 * 2
logger = logging.getLogger(__name__)


def installed(path: Path) -> bool:
    return all((path / name).is_file() for name in REQUIRED_FILES)


def require_platform(authorization: str | None = Header(default=None)) -> None:
    if not verify_api_token(authorization, None, get_settings()):
        raise HTTPException(401, "Authentication required")


class DictationService:
    def __init__(self):
        self.settings = get_settings()
        self.root = Path(self.settings.storage_dir)
        self.models = self.root / "models"
        self.selection = self.root / "selected-model.json"
        self.models.mkdir(parents=True, exist_ok=True)
        self.asr = WhisperAsr(self.settings)
        self.active: str | None = None
        self.loading: str | None = None
        self.downloading: str | None = None
        self.error: str | None = None
        self.lock = asyncio.Lock()
        self.tasks: set[asyncio.Task] = set()

    def path(self, model_id: str) -> Path:
        if model_id == "quality":
            configured = Path(self.settings.whisper_model)
            if installed(configured):
                return configured
        return self.models / CATALOG[model_id]

    def status(self) -> dict:
        return {
            "active": self.active,
            "loading": self.loading,
            "downloading": self.downloading,
            "error": self.error,
            "models": [
                {"id": model_id, "name": CATALOG[model_id], "installed": installed(self.path(model_id))}
                for model_id in CATALOG
            ],
        }

    def start_task(self, work):
        task = asyncio.create_task(work)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    def warm(self, model_id: str) -> None:
        with tempfile.TemporaryDirectory(dir=self.root) as directory:
            path = Path(directory) / "warmup.wav"
            with wave.open(str(path), "wb") as wav:
                wav.setparams((1, 2, 16_000, 0, "NONE", ""))
                wav.writeframes(bytes(32_000))
            self.asr.transcribe_chunks(path, language="ru", progress_callback=None, model_name=str(self.path(model_id)))

    def persist(self, model_id: str) -> None:
        temporary = self.selection.with_suffix(".tmp")
        temporary.write_text(json.dumps({"model": model_id}), encoding="utf-8")
        temporary.replace(self.selection)

    async def activate(self, model_id: str) -> None:
        previous = self.active
        try:
            async with self.lock:
                try:
                    await asyncio.to_thread(self.warm, model_id)
                    self.persist(model_id)
                    self.active = model_id
                except Exception:
                    logger.exception("Could not load selected dictation model")
                    self.active = None
                    self.error = "Не удалось загрузить модель распознавания."
                    if previous:
                        try:
                            await asyncio.to_thread(self.warm, previous)
                            self.active = previous
                        except Exception:
                            logger.exception("Could not restore previous dictation model")
        finally:
            self.loading = None

    async def preload(self) -> None:
        try:
            preferred = json.loads(self.selection.read_text(encoding="utf-8")).get("model")
        except (OSError, ValueError, AttributeError):
            preferred = None
        order = [preferred] if isinstance(preferred, str) and preferred in CATALOG else []
        order.extend(model_id for model_id in ("quality", "turbo") if model_id not in order)
        for model_id in order:
            if installed(self.path(model_id)):
                self.loading = model_id
                await self.activate(model_id)
                if self.active:
                    return

    def fetch_model(self, model_id: str) -> None:
        target = self.path(model_id)
        with tempfile.TemporaryDirectory(dir=self.models) as directory:
            stage = Path(directory) / "model"
            download_model(CATALOG[model_id], output_dir=str(stage))
            if not installed(stage):
                raise RuntimeError("Incomplete Faster Whisper download")
            stage.replace(target)

    async def download(self, model_id: str) -> None:
        try:
            await asyncio.to_thread(self.fetch_model, model_id)
        except Exception:
            logger.exception("Could not download dictation model")
            self.error = "Не удалось скачать модель. Проверьте доступ сервера к Hugging Face и свободное место."
        finally:
            self.downloading = None

    def recognize(self, audio: bytes, model_id: str) -> str:
        with tempfile.TemporaryDirectory(dir=self.root) as directory:
            path = Path(directory) / "dictation.wav"
            path.write_bytes(audio)
            chunks, _ = self.asr.transcribe_chunks(path, language=None, progress_callback=None, model_name=str(self.path(model_id)))
            return " ".join(chunk.text.strip() for chunk in chunks).strip()


@asynccontextmanager
async def lifespan(app: FastAPI):
    service = DictationService()
    app.state.dictation = service
    await service.preload()
    try:
        yield
    finally:
        if service.tasks:
            await asyncio.gather(*service.tasks, return_exceptions=True)


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


def service() -> DictationService:
    return app.state.dictation


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/agent-platform/models", dependencies=[Depends(require_platform)])
async def models():
    return service().status()


@app.post("/agent-platform/models/{model_id}/download", status_code=202, dependencies=[Depends(require_platform)])
async def download(model_id: ModelId):
    engine = service()
    if installed(engine.path(model_id)):
        return engine.status()
    if engine.downloading:
        raise HTTPException(409, "A model download is already running")
    engine.error = None
    engine.downloading = model_id
    engine.start_task(engine.download(model_id))
    return engine.status()


@app.post("/agent-platform/models/{model_id}/select", status_code=202, dependencies=[Depends(require_platform)])
async def select(model_id: ModelId):
    engine = service()
    if engine.loading:
        raise HTTPException(409, "A model is already loading")
    if not installed(engine.path(model_id)):
        raise HTTPException(409, "Download the model before selecting it")
    if engine.active != model_id:
        engine.error = None
        engine.loading = model_id
        engine.start_task(engine.activate(model_id))
    return engine.status()


@app.post("/transcriptions", dependencies=[Depends(require_platform)])
async def transcribe(file: UploadFile = File(...)):
    engine = service()
    audio = await file.read(MAX_AUDIO + 1)
    await file.close()
    if len(audio) > MAX_AUDIO:
        raise HTTPException(413, "Recording is too long")
    if len(audio) <= 44 or audio[:4] != b"RIFF" or audio[8:12] != b"WAVE":
        raise HTTPException(400, "Expected a WAV recording")
    async with engine.lock:
        if not engine.active or engine.loading:
            raise HTTPException(503, "The dictation model is loading or unavailable")
        return {"text": await asyncio.to_thread(engine.recognize, audio, engine.active)}
