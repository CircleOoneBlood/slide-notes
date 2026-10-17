"""Copy the small font/icon subset used by the workbench, including licenses."""
from pathlib import Path
import argparse
import hashlib
import json
import re
import shutil
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", type=Path, default=ROOT.parent / "src" / "slide_notes" / "static")
STATIC = parser.parse_args().output.resolve()
STATIC.mkdir(parents=True, exist_ok=True)
LOCKED_PACKAGES = json.loads((ROOT / "package-lock.json").read_text())['packages']
ICONS = "folder-tree variable package list-tree workflow file-text folder notebook-text search cpu memory-stick hard-drive panel-left refresh-cw arrow-up arrow-down square-pen circle-help move-diagonal chevron-down chevron-right download upload x plus minus play arrow-left arrow-right list-plus list-minus square ellipsis trash-2 grip-vertical panels-top-left layers-2 eye-off code-xml panel-left-open panel-left-close square-code square-m link-2 unlink-2 sparkles settings-2 send check history chevron-up scan image git-compare locate-fixed list-collapse focus bookmark zap message-circle arrow-up-right square-slash eye".split()

ET.register_namespace("", "http://www.w3.org/2000/svg")
sprite = ET.Element("{http://www.w3.org/2000/svg}svg")
for name in ICONS:
    source = ET.parse(ROOT / "node_modules/lucide-static/icons" / f"{name}.svg").getroot()
    symbol = ET.SubElement(sprite, "symbol", id=name, viewBox="0 0 24 24")
    for element in source:
        symbol.append(element)
ET.ElementTree(sprite).write(STATIC / "icons.svg", encoding="unicode")

(STATIC / "fonts").mkdir(exist_ok=True)
(STATIC / "licenses").mkdir(exist_ok=True)
for family, weights in (("pt-sans", (400, 700)), ("fira-mono", (400,))):
    package = ROOT / "node_modules/@fontsource" / family
    for weight in weights:
        name = f"{family}-latin-{weight}-normal.woff2"
        shutil.copyfile(package / "files" / name, STATIC / "fonts" / name)
    shutil.copyfile(package / "LICENSE", STATIC / "licenses" / f"{family}.txt")
shutil.copyfile(ROOT / "node_modules/lucide-static/LICENSE", STATIC / "licenses/lucide.txt")
print("Built local fonts and icon sprite.")

# Ship browser dependencies in the Python wheel: end users never need npm.
(STATIC / 'vendor').mkdir(exist_ok=True)
for source, target in [('dompurify/dist/purify.min.js','purify.js'),('@dagrejs/dagre/dist/dagre.min.js','dagre.js')]:
    shutil.copyfile(ROOT/'node_modules'/source, STATIC/'vendor'/target)
shutil.copytree(ROOT/'node_modules/katex/dist',STATIC/'vendor/katex',dirs_exist_ok=True)
for package, name in [('dompurify','dompurify'),('@dagrejs/dagre','dagre'),('katex','katex')]:
    source=ROOT/'node_modules'/package
    licenses=sorted(source.glob('LICENSE*'))
    if licenses: shutil.copyfile(licenses[0], STATIC/'licenses'/f'{name}.txt')

# PDF.js runs fully offline, including CJK maps, fallback fonts and image decoders.
pdf_source = ROOT/'node_modules/pdfjs-dist'
pdf_target = STATIC/'vendor/pdfjs'
pdf_target.mkdir(exist_ok=True)
for source, target in [('build/pdf.min.mjs','pdf.mjs'), ('build/pdf.worker.min.mjs','pdf.worker.mjs'),
                       ('web/pdf_viewer.mjs','pdf_viewer.mjs'), ('web/pdf_viewer.css','pdf_viewer.css')]:
    shutil.copyfile(pdf_source/source, pdf_target/target)
for folder in ('cmaps','standard_fonts','wasm','iccs'):
    shutil.copytree(pdf_source/folder,pdf_target/folder,dirs_exist_ok=True)
shutil.copytree(pdf_source/'web/images',pdf_target/'images',dirs_exist_ok=True)
shutil.copyfile(pdf_source/'LICENSE',STATIC/'licenses/pdfjs.txt')

# Offline MathJax CHTML fonts and licenses for the independent Markdown engine.
shutil.copytree(ROOT/'node_modules/mathjax-full/es5/output/chtml/fonts/woff-v2',STATIC/'vendor/mathjax',dirs_exist_ok=True)
# Include every license variant from installed lockfile packages, including
# nested versions. Never scan orphan packages from an older node_modules tree.
# The readable name identifies the dependency chain; the source-path digest
# distinguishes scopes, casing and license variants without name collisions.
license_names = set()
for package_path in sorted(LOCKED_PACKAGES):
    if not package_path.startswith('node_modules/'):
        continue
    package = ROOT / package_path
    if not package.is_dir():  # Optional packages for another operating system.
        continue
    for source in sorted(package.iterdir()):
        if not source.is_file() or not source.name.lower().startswith(('license', 'copying')):
            continue
        identity = source.relative_to(ROOT).as_posix()
        readable = identity.removeprefix('node_modules/').replace('/node_modules/', '--')
        readable = re.sub(r'[^A-Za-z0-9._-]+', '-', readable).strip('-')[:120]
        digest = hashlib.sha256(identity.encode()).hexdigest()[:16]
        name = f'npm-{readable}-{digest}.txt'
        if name in license_names:
            raise ValueError(f'Duplicate generated license filename: {name}')
        license_names.add(name)
        shutil.copyfile(source, STATIC / 'licenses' / name)
print(f'Copied {len(license_names)} lockfile dependency license files, including nested packages.')
