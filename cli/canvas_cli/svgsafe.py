"""SVG sanitizer: the source SVG is only ever emitted after passing through here.

Strips ``<script>``, ``<foreignObject>`` (HTML smuggling), ``<metadata>``, every
``on*`` attribute, every ``href`` / ``xlink:href`` that is not a ``data:`` URI
or a ``#fragment``, and external ``url(...)`` / ``@import`` references in CSS
and presentation attributes. Comments, processing instructions and the DOCTYPE
are dropped by the parser/serializer round trip.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET

SVG_NS = "http://www.w3.org/2000/svg"

_NAMESPACES = {
    "": SVG_NS,
    "xlink": "http://www.w3.org/1999/xlink",
    "inkscape": "http://www.inkscape.org/namespaces/inkscape",
    "sodipodi": "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd",
    "dc": "http://purl.org/dc/elements/1.1/",
    "cc": "http://creativecommons.org/ns#",
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
}
for _prefix, _uri in _NAMESPACES.items():
    ET.register_namespace(_prefix, _uri)

_BANNED_TAGS = {"script", "foreignobject", "metadata", "iframe", "object", "embed"}
_ANIMATION_TAGS = {"animate", "set", "animatetransform", "animatemotion"}
_URL_RE = re.compile(r"""url\(\s*(['"]?)(.*?)\1\s*\)""", re.IGNORECASE | re.DOTALL)
_IMPORT_RE = re.compile(r"@import\b[^;]*;?", re.IGNORECASE)
_JS_RE = re.compile(r"javascript\s*:", re.IGNORECASE)
_HTML_DATA_RE = re.compile(r"^data:\s*(text/html|application/xhtml)", re.IGNORECASE)


class SvgError(Exception):
    """The input is not an SVG we can safely re-emit."""


def _local(name: object) -> str:
    if not isinstance(name, str):
        return ""
    return name.rsplit("}", 1)[-1].lower()


def _href_allowed(value: str) -> bool:
    value = value.strip()
    if value.startswith("#"):
        return True
    return value.lower().startswith("data:") and not _HTML_DATA_RE.match(value)


def _clean_css(text: str) -> str:
    text = _IMPORT_RE.sub("", text)
    text = _JS_RE.sub("", text)

    def swap(match: re.Match[str]) -> str:
        target = match.group(2).strip()
        if target.startswith("#") or target.lower().startswith("data:"):
            return match.group(0)
        return "none"

    return _URL_RE.sub(swap, text)


def _clean(elem: ET.Element) -> None:
    for child in list(elem):
        name = _local(child.tag)
        if not isinstance(child.tag, str) or name in _BANNED_TAGS:
            elem.remove(child)
            continue
        if name in _ANIMATION_TAGS:
            target = _local(child.attrib.get("attributeName", ""))
            if target == "href" or target.startswith("on"):
                elem.remove(child)
                continue
        _clean(child)

    for attr in list(elem.attrib):
        name = _local(attr)
        value = elem.attrib[attr]
        if name.startswith("on"):
            del elem.attrib[attr]
        elif name == "href":
            if not _href_allowed(value):
                del elem.attrib[attr]
        elif name == "style" or "url(" in value.lower() or "javascript" in value.lower():
            elem.attrib[attr] = _clean_css(value)

    if _local(elem.tag) == "style" and elem.text:
        elem.text = _clean_css(elem.text)


def sanitize_svg(data: bytes) -> str:
    """Return a sanitized SVG document as a string, or raise :class:`SvgError`."""
    if re.search(rb"<!ENTITY", data, re.IGNORECASE):
        raise SvgError("entity declarations are not supported")
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise SvgError(f"not well-formed XML: {exc}") from exc
    if _local(root.tag) != "svg":
        raise SvgError("root element is not <svg>")
    _clean(root)
    if not root.tag.startswith("{"):
        root.set("xmlns", SVG_NS)
    return ET.tostring(root, encoding="unicode")


_LENGTH_RE = re.compile(r"^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$")


def svg_dimensions(svg: str) -> tuple[float, float] | None:
    """Width and height of a (sanitized) SVG from its root attributes, if numeric."""
    try:
        root = ET.fromstring(svg)
    except ET.ParseError:
        return None
    width = _LENGTH_RE.match(root.attrib.get("width", ""))
    height = _LENGTH_RE.match(root.attrib.get("height", ""))
    if width and height:
        return float(width.group(1)), float(height.group(1))
    box = root.attrib.get("viewBox", "").replace(",", " ").split()
    if len(box) == 4:
        try:
            return float(box[2]), float(box[3])
        except ValueError:
            return None
    return None
