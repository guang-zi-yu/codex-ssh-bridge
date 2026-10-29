#!/usr/bin/env python3
"""Build dependency-free VSIX packages from the two extension directories."""
from pathlib import Path
from xml.sax.saxutils import escape
import json
import shutil
import zipfile
ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / 'dist'
DIST.mkdir(exist_ok=True)

def build(folder):
    source = ROOT / folder
    pkg = json.loads((source / 'package.json').read_text())
    name = f"{pkg['name']}-{pkg['version']}.vsix"
    target = DIST / name
    manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
<Metadata><Identity Language="en-US" Id="{pkg['name']}" Version="{pkg['version']}" Publisher="{pkg['publisher']}"/>
<DisplayName>{escape(pkg['displayName'])}</DisplayName><Description xml:space="preserve">{escape(pkg['description'])}</Description>
<Tags>codex,ssh,remote</Tags><Categories>Other</Categories><GalleryFlags>Public</GalleryFlags>
<Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="{escape(pkg['engines']['vscode'])}"/>
<Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="{','.join(pkg['extensionKind'])}"/>
<Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true"/></Properties></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
<Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
<Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true"/></Assets></PackageManifest>'''
    types = '''<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="css" ContentType="text/css"/><Default Extension="svg" ContentType="image/svg+xml"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="vsix" ContentType="application/octet-stream"/><Default Extension="vsixmanifest" ContentType="text/xml"/><Default Extension="" ContentType="text/plain"/></Types>'''
    worker = json.loads((ROOT / 'worker' / 'package.json').read_text())
    expected_helper = f"{worker['name']}-{worker['version']}.vsix"
    if folder == 'client' and not (source / 'bundled' / expected_helper).is_file():
        raise RuntimeError('Build the matching remote helper before the client')
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('extension.vsixmanifest', manifest)
        z.writestr('[Content_Types].xml', types)
        for f in sorted(source.rglob('*')):
            relative = f.relative_to(source)
            if folder == 'client' and relative.parts[0] == 'bundled' and relative.as_posix() != 'bundled/' + expected_helper:
                continue
            if f.is_file(): z.write(f, 'extension/' + relative.as_posix())
    print(target)
    return target

if __name__ == '__main__':
    helper = build('worker')
    bundled = ROOT / 'client' / 'bundled'
    bundled.mkdir(exist_ok=True)
    shutil.copyfile(helper, bundled / helper.name)
    build('client')
