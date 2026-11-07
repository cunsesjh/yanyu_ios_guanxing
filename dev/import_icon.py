"""Prepare the user-supplied square artwork for Qt and Windows executable icons."""
import argparse
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parents[1]


def convert(source):
    image = Image.open(source).convert('RGB')
    if image.width != image.height:
        raise ValueError('Expected square source artwork')
    size = image.width
    # The source watermark is below the mountain highlights, in the black corner.
    # Reflect the matching clean left corner so the rounded silhouette is retained.
    x, y = round(size * .818), round(size * .942)
    patch = ImageOps.mirror(image.crop((0, y, size - x, size)))
    image.paste(patch, (x, y))
    # Remove only near-white areas connected to the outer corners. Cream highlights
    # inside the artwork are deliberately excluded from the transparency mask.
    candidate = Image.new('L', image.size)
    candidate.putdata([255 if min(rgb) > 205 and max(rgb) - min(rgb) < 24 else 0
                       for rgb in image.getdata()])
    for corner in [(0, 0), (size - 1, 0), (0, size - 1), (size - 1, size - 1)]:
        ImageDraw.floodfill(candidate, corner, 128, thresh=0)
    alpha = candidate.point(lambda p: 0 if p == 128 else 255)
    image = image.convert('RGBA')
    image.putalpha(alpha)
    assets = ROOT / 'assets'
    master = image.resize((1024, 1024), Image.Resampling.LANCZOS)
    master.save(assets / 'iosGuanxing.png', optimize=True)
    master.save(assets / 'iosGuanxing.ico', sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)])
    preview = Image.new('RGB', (640, 320), '#edf2f9')
    ImageDraw.Draw(preview).rectangle((320, 0, 640, 320), fill='#111925')
    for x in (32, 352):
        preview.paste(master.resize((256, 256), Image.Resampling.LANCZOS), (x, 32),
                      master.resize((256, 256), Image.Resampling.LANCZOS))
    folder = ROOT / 'build' / 'icon'
    folder.mkdir(parents=True, exist_ok=True)
    preview.save(folder / 'preview.png')
    print('Saved 1024px RGBA PNG and Windows ICO (16/24/32/48/64/128/256px)')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    convert(parser.parse_args().source)
