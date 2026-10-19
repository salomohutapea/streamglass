"""Incremental SSE framing. Byte framing preserves unchanged events exactly."""
import codecs

MAX_EVENT = 8 * 1024 * 1024


class EventTooLarge(ValueError):
    def __init__(self, events, raw):
        super().__init__("SSE event exceeds 8 MiB")
        self.events, self.raw = events, raw


class SSEParser:
    def __init__(self):
        self.buffer = bytearray()
        self.lines = []
        self.block = bytearray()
        self.first = True

    def feed(self, chunk, end=False):
        self.buffer.extend(chunk)
        events = []
        while self.buffer:
            indexes = [i for i in (self.buffer.find(b"\r"), self.buffer.find(b"\n")) if i >= 0]
            if not indexes:
                break
            index = min(indexes)
            if self.buffer[index] == 13 and index + 1 == len(self.buffer) and not end:
                break
            width = 2 if self.buffer[index:index + 2] == b"\r\n" else 1
            line = bytes(self.buffer[:index])
            raw = bytes(self.buffer[:index + width])
            del self.buffer[:index + width]
            self.block.extend(raw)
            if len(self.block) > MAX_EVENT:
                raise EventTooLarge(events, bytes(self.block + self.buffer))
            if self.first:
                line = line.removeprefix(codecs.BOM_UTF8)
                self.first = False
            if line:
                self.lines.append(line)
            else:
                fields = {"event": "message", "data": "", "id": None, "retry": None}
                data = []
                for entry in self.lines:
                    key, sep, value = entry.partition(b":")
                    if value.startswith(b" "):
                        value = value[1:]
                    key = key.decode("utf-8", "replace")
                    text = value.decode("utf-8", "replace")
                    if key == "data":
                        data.append(text)
                    elif key == "event":
                        fields[key] = text or "message"
                    elif key == "id" and "\x00" not in text:
                        fields[key] = text
                    elif key == "retry" and text.isascii() and text.isdigit():
                        # Bound metadata conversion; the original frame still forwards intact.
                        digits = text.lstrip("0") or "0"
                        if len(digits) <= 16 and int(digits) <= 2**53 - 1:
                            fields[key] = int(digits)
                fields["data"] = "\n".join(data)
                fields["raw"] = self.block.decode("utf-8", "replace")
                fields["dispatch"] = bool(data)
                fields["_bytes"] = bytes(self.block)
                events.append(fields)
                self.lines.clear()
                self.block.clear()
        if len(self.buffer) + len(self.block) > MAX_EVENT:
            raise EventTooLarge(events, bytes(self.block + self.buffer))
        if end and (self.buffer or self.block):
            events.append({"raw": (self.block + self.buffer).decode("utf-8", "replace"),
                           "dispatch": False, "_bytes": bytes(self.block + self.buffer)})
            self.buffer.clear()
            self.block.clear()
        return events


def serialize(event):
    event_type = str(event.get("event", "message"))
    event_id = event.get("id")
    if any(c in event_type for c in "\r\n") or (event_id is not None and any(c in str(event_id) for c in "\r\n\x00")):
        raise ValueError("SSE type/id must be a single line")
    parts = [f"event: {event_type}\n"]
    if event_id is not None:
        parts.append(f"id: {event_id}\n")
    if event.get("retry") is not None:
        retry = int(event["retry"])
        if retry < 0:
            raise ValueError("SSE retry must be nonnegative")
        parts.append(f"retry: {retry}\n")
    parts.extend(f"data: {line}\n" for line in str(event.get("data", "")).replace("\r\n", "\n").replace("\r", "\n").split("\n"))
    result = ("".join(parts) + "\n").encode()
    if len(result) > MAX_EVENT:
        raise ValueError("Edited SSE event exceeds 8 MiB")
    return result
