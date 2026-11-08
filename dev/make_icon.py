"""Generate a temporary compass icon with standard-library PNG/ICO encoding."""
from pathlib import Path
import math
import struct
import zlib

ROOT = Path(__file__).resolve().parents[1] / 'assets'


def chunk(kind, data):
    return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))


def render(size):
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            u, v = (x + .5) / size, (y + .5) / size
            radius = math.hypot(u - .5, v - .5)
            rgba = (20, 44, 59, 255)
            if abs(u - .5) > .45 or abs(v - .5) > .45:
                rgba = (0, 0, 0, 0)
            if .305 < radius < .324:
                rgba = (68, 116, 134, 255)
            if abs(u - .5) + abs(v - .5) < .20:
                rgba = (120, 225, 199, 255)
            if abs(u - .5) < .018 and .15 < v < .85 or abs(v - .5) < .018 and .15 < u < .85:
                rgba = (120, 225, 199, 255)
            if radius < .045:
                rgba = (20, 44, 59, 255)
            row.extend(rgba)
        rows.append(b'\0' + bytes(row))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', size, size, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(b''.join(rows))) + chunk(b'IEND', b''))


if __name__ == '__main__':
    ROOT.mkdir(exist_ok=True)
    sizes = [16, 32, 48, 64, 128, 256]
    images = [render(size) for size in sizes]
    header = struct.pack('<3H', 0, 1, len(sizes))
    entries = b''
    offset = 6 + 16 * len(sizes)
    for size, image in zip(sizes, images):
        entries += struct.pack('<4B2H2I', size % 256, size % 256, 0, 0, 1, 32, len(image), offset)
        offset += len(image)
    (ROOT / 'iosGuanxing.ico').write_bytes(header + entries + b''.join(images))
    (ROOT / 'iosGuanxing.png').write_bytes(images[-1])
