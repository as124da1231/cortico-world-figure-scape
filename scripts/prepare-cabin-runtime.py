"""Stage the pinned Cabin World release with the licensed Mochi staff artwork."""

import argparse
import hashlib
import json
import mmap
from pathlib import Path, PurePosixPath
import shutil
import struct
import tempfile
import zipfile


VERSION = '1.1.0'
RELEASE_TAG = 'cabin-world-1.1.0-scape.1'
ARCHIVE_NAME = 'figure-scape-cabin-world-1.1.0-scape.1-win-x64.zip'
UPSTREAM_SHA256 = '78cb15140a1f874b5b19efea3627775bc89acc99bf3b8b55cd8f6a6c49c5f6e0'
EXCLUDED_ART = ('naiwa-games-v1.png', 'shop-cashier-laugh-v1.png', 'shop-cashier-v1.png')
ENTRY = struct.Struct('<QQ16sI')
FOOTER = struct.Struct('<Q4s')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def pack_entries(binary):
    size, magic = FOOTER.unpack_from(binary, len(binary) - FOOTER.size)
    start = len(binary) - FOOTER.size - size
    if magic != b'GDPC' or start < 0 or struct.unpack_from('<4sIIIII', binary, start) != (b'GDPC', 4, 4, 7, 2, 2):
        raise ValueError('Expected the embedded export from Cabin World 1.1.0')
    file_base, index = struct.unpack_from('<QQ', binary, start + 24)
    base, table = start + file_base, start + index
    count = struct.unpack_from('<I', binary, table)[0]
    offset, entries = table + 4, {}
    for _ in range(count):
        length = struct.unpack_from('<I', binary, offset)[0]
        offset += 4
        name = binary[offset:offset + length].rstrip(b'\0').decode('utf-8')
        offset += length
        begin, length, checksum, flags = ENTRY.unpack_from(binary, offset)
        if flags or name in entries or base + begin + length > table:
            raise ValueError('Unexpected Cabin World package entry')
        entries[name] = (begin, length, checksum, flags)
        offset += ENTRY.size
    return base, table, offset, entries


def excluded(path):
    name = PurePosixPath(path).name
    return name in EXCLUDED_ART or any(name.startswith(sprite + suffix) for sprite in EXCLUDED_ART for suffix in ('.import', '-'))


def sanitized_export(source, destination):
    if digest(source) != UPSTREAM_SHA256:
        raise ValueError('CabinWorld.exe does not match the pinned upstream Windows export')
    with source.open('rb') as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as binary:
        base, table, old_table_end, entries = pack_entries(binary)
        restricted = {name: entry for name, entry in entries.items() if excluded(name)}
        if len(restricted) != 6:
            raise ValueError('Unexpected inventory of the three excluded sprite imports')
        patches = {base + begin: bytes(length) for begin, length, _, _ in restricted.values()}
        entries = {name: entry for name, entry in entries.items() if name not in restricted}
        npc_path = 'assets/npcs.json'
        begin, length, _, flags = entries[npc_path]
        npcs = json.loads(binary[base + begin:base + begin + length])
        # The game's legacy NPC preference can still resolve to the licensed character art.
        npcs['skins']['naiwa'] = npcs['skins']['mochi']
        content = json.dumps(npcs, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        if len(content) > length or any(name.encode() in content for name in EXCLUDED_ART):
            raise ValueError('Unexpected replacement NPC catalogue')
        patches[base + begin] = content.ljust(length, b'\0')
        entries[npc_path] = (begin, len(content), hashlib.md5(content).digest(), flags)

        directory = bytearray(struct.pack('<I', len(entries)))
        for name, entry in entries.items():
            encoded = name.encode('utf-8')
            encoded = encoded.ljust((len(encoded) + 3) // 4 * 4, b'\0')
            directory.extend(struct.pack('<I', len(encoded)) + encoded + ENTRY.pack(*entry))
        if len(directory) > old_table_end - table:
            raise ValueError('The replacement directory exceeds the space in the original export')
        patches[table] = bytes(directory).ljust(old_table_end - table, b'\0')

        # Keep the Windows executable's embedded PCK section and footer offsets intact.
        with destination.open('wb') as output:
            view = memoryview(binary)
            cursor = 0
            try:
                for position, replacement in sorted(patches.items()):
                    output.write(view[cursor:position])
                    output.write(replacement)
                    cursor = position + len(replacement)
                output.write(view[cursor:])
            finally:
                view.release()
    with destination.open('rb') as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as binary:
        _, _, _, entries = pack_entries(binary)
        if any(excluded(name) or name.startswith(('data/', 'saves/')) for name in entries):
            raise ValueError('Excluded art or saves in the staged package')


def stage(source, destination):
    destination.mkdir(parents=True, exist_ok=True)
    sanitized_export(source / 'CabinWorld.exe', destination / 'CabinWorld.exe')
    bridge = destination / 'bridge'
    bridge.mkdir()
    for name in ('bridge.mjs', 'cabin-host.mjs', 'catalog.json', 'openai-tools.json'):
        shutil.copyfile(source / 'bridge' / name, bridge / name)
    shutil.copyfile(source / 'bridge/bridge.config.example.json', bridge / 'bridge.config.json')
    for name in ('lib', 'update'):
        shutil.copytree(source / 'bridge' / name, bridge / name)

    assets = destination / 'game/assets'
    assets.mkdir(parents=True)
    for name in ('world.json', 'residents.json'):
        shutil.copyfile(source / 'game/assets' / name, assets / name)
    shutil.copytree(source / 'game/assets/actors', assets / 'actors', ignore=shutil.ignore_patterns('*.import'))

    for name in ('LICENSE', 'LICENSE-NOTES.md'):
        shutil.copyfile(source / name, destination / name)
    shutil.copytree(source / 'third-party/godot', destination / 'third-party/godot')
    published = {'version': VERSION, 'source': 'https://github.com/BabyBus2022/cabin-world/releases/tag/V1.1.0',
                 'gameSha256': digest(destination / 'CabinWorld.exe'), 'credit': 'Cabin World by VADS',
                 'changes': 'Replaced the unlicensed Naiwa sprite imports with the upstream Mochi appearance.'}
    (destination / 'manifest.json').write_text(json.dumps(published, indent=2) + '\n', encoding='utf-8')


def archive_runtime(runtime, directory):
    manifest = json.loads((runtime / 'manifest.json').read_text(encoding='utf-8'))
    if manifest['version'] != VERSION or digest(runtime / 'CabinWorld.exe') != manifest['gameSha256']:
        raise ValueError('The prepared runtime does not match its manifest')
    files = sorted(runtime.rglob('*'))
    for file in files:
        name = file.name.lower()
        if (file.is_symlink() or excluded(file.as_posix())
            or name in {'data', 'saves', 'world', 'layouts', 'backups', 'bridge.json', 'cabinworld.ini'}
            or name.endswith('.log') or name.startswith('.figure-scape-')):
            raise ValueError(f'Unexpected local file in the runtime: {file.relative_to(runtime)}')
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / ARCHIVE_NAME
    with tempfile.TemporaryDirectory(prefix='.cabin-zip-', dir=directory) as temporary:
        staged = Path(temporary) / ARCHIVE_NAME
        with zipfile.ZipFile(staged, 'w') as archive:
            for file in files:
                if not file.is_file():
                    continue
                path = 'cabin-runtime/' + file.relative_to(runtime).as_posix()
                info = zipfile.ZipInfo(path)
                info.compress_type = zipfile.ZIP_DEFLATED
                with file.open('rb') as source, archive.open(info, 'w') as target:
                    shutil.copyfileobj(source, target)
        staged.replace(destination)
    print(json.dumps({
        'version': RELEASE_TAG.removeprefix('cabin-world-'),
        'releaseTag': RELEASE_TAG, 'asset': ARCHIVE_NAME,
        'bytes': destination.stat().st_size, 'sha256': digest(destination),
        'exportSha256': manifest['gameSha256'],
    }, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('release', nargs='?', type=Path, help='Cleanly extracted official Windows release folder')
    action.add_argument('--archive', type=Path, help='Output directory for a ZIP of the prepared runtime')
    args = parser.parse_args()
    output = Path(__file__).resolve().parents[1] / 'cabin-runtime'
    if args.archive:
        archive_runtime(output, args.archive.resolve())
        raise SystemExit
    if output.exists():
        parser.error(f'{output} already exists. Move the previous bundle aside before rebuilding it.')
    with tempfile.TemporaryDirectory(prefix='.cabin-build-', dir=output.parent) as temporary:
        ready = Path(temporary) / 'runtime'
        stage(args.release.resolve(), ready)
        ready.rename(output)
    print(output)
