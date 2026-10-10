"""Kind and MIME detection from the file name, with a content sniff for unknowns."""

from __future__ import annotations

import mimetypes
import os

AUDIO_EXTS = {
    "wav": "audio/wav", "mp3": "audio/mpeg", "flac": "audio/flac", "aif": "audio/aiff",
    "aiff": "audio/aiff", "ogg": "audio/ogg", "oga": "audio/ogg", "opus": "audio/opus",
    "m4a": "audio/mp4", "aac": "audio/aac", "caf": "audio/x-caf", "wma": "audio/x-ms-wma",
}
IMAGE_EXTS = {
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp",
    "gif": "image/gif", "heic": "image/heic", "heif": "image/heif", "bmp": "image/bmp",
    "tif": "image/tiff", "tiff": "image/tiff", "avif": "image/avif",
}
VIDEO_EXTS = {
    "mp4": "video/mp4", "mov": "video/quicktime", "m4v": "video/x-m4v",
    "mkv": "video/x-matroska", "webm": "video/webm", "avi": "video/x-msvideo",
    "mpg": "video/mpeg", "mpeg": "video/mpeg",
}
DOCUMENT_EXTS = {
    "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xls": "application/vnd.ms-excel",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "ppt": "application/vnd.ms-powerpoint",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "rtf": "application/rtf", "rtfd": "application/x-rtfd", "pages": "application/x-iwork-pages-sffpages",
    "key": "application/x-iwork-keynote-sffkey", "numbers": "application/x-iwork-numbers-sffnumbers",
    "odt": "application/vnd.oasis.opendocument.text",
    "ods": "application/vnd.oasis.opendocument.spreadsheet",
    "odp": "application/vnd.oasis.opendocument.presentation",
    "epub": "application/epub+zip",
}
TEXT_EXTS = {
    "txt": "text/plain", "md": "text/markdown", "markdown": "text/markdown", "rst": "text/x-rst",
    "log": "text/plain", "csv": "text/csv", "tsv": "text/tab-separated-values",
    "json": "application/json", "yaml": "application/yaml", "yml": "application/yaml",
    "toml": "application/toml", "ini": "text/plain", "cfg": "text/plain", "conf": "text/plain",
    "xml": "application/xml", "html": "text/html", "htm": "text/html", "css": "text/css",
    "js": "text/javascript", "ts": "text/typescript", "tsx": "text/typescript",
    "jsx": "text/javascript", "py": "text/x-python", "sh": "text/x-shellscript",
    "rs": "text/x-rust", "go": "text/x-go", "c": "text/x-c", "h": "text/x-c",
    "cpp": "text/x-c++", "scd": "text/plain", "tex": "text/x-tex",
}

#: Images Pillow cannot open but Quick Look can.
QUICKLOOK_IMAGE_EXTS = {"heic", "heif", "avif"}

MARKDOWN_EXTS = {"md", "markdown"}


def extension(path: str) -> str:
    return os.path.splitext(path)[1].lstrip(".").lower()


def kind_from_extension(path: str) -> str | None:
    """Best guess from the extension alone, or ``None`` when it says nothing."""
    ext = extension(path)
    if ext in AUDIO_EXTS:
        return "audio"
    if ext in IMAGE_EXTS:
        return "image"
    if ext in VIDEO_EXTS:
        return "video"
    if ext == "svg":
        return "svg"
    if ext == "pdf":
        return "pdf"
    if ext in DOCUMENT_EXTS:
        return "document"
    if ext in TEXT_EXTS:
        return "text"
    return None


def mime_for(path: str, kind: str | None) -> str:
    ext = extension(path)
    for table in (AUDIO_EXTS, IMAGE_EXTS, VIDEO_EXTS, DOCUMENT_EXTS, TEXT_EXTS):
        if ext in table:
            return table[ext]
    if ext == "svg":
        return "image/svg+xml"
    if ext == "pdf":
        return "application/pdf"
    guessed, _ = mimetypes.guess_type(path)
    if guessed:
        return guessed
    return "text/plain" if kind == "text" else "application/octet-stream"


def looks_like_text(head: bytes) -> bool:
    """True when ``head`` (the first bytes of a file) is plausibly UTF-8 text."""
    if not head or b"\0" in head:
        return False
    try:
        head.decode("utf-8")
    except UnicodeDecodeError as exc:
        # A multi-byte character cut by the sniff window is not binary.
        if exc.start < len(head) - 4:
            return False
    return True
