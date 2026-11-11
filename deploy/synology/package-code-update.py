"""Package compiled code over a verified ARM64 Docker save archive.

Only for code-only updates with unchanged runtime and dependencies. A full
Docker build is required when runtime, Dockerfile, or dependencies change.
"""
import argparse
import datetime
import gzip
import hashlib
import io
import json
import pathlib
import tarfile
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("base")
parser.add_argument("image")
parser.add_argument("output")
args = parser.parse_args()


def add_bytes(archive, name, content):
    info = tarfile.TarInfo(name)
    info.size = len(content)
    info.mode = 0o644
    archive.addfile(info, io.BytesIO(content))


with tarfile.open(args.base) as source:
    manifest = json.load(source.extractfile("manifest.json"))[0]
    config_bytes = source.extractfile(manifest["Config"]).read()
    assert hashlib.sha256(config_bytes).hexdigest() in manifest["Config"]
    config = json.loads(config_bytes)
    assert config["architecture"] == "arm64" and config["os"] == "linux"
    package = None
    for name in manifest["Layers"]:
        with tarfile.open(fileobj=source.extractfile(name), mode="r|gz") as layer:
            for member in layer:
                if member.name.lstrip("./") == "app/package.json":
                    package = json.load(layer.extractfile(member))
                    break
    assert package["dependencies"] == json.load(open("package.json"))["dependencies"]
    with tempfile.TemporaryFile() as patch:
        with tarfile.open(fileobj=patch, mode="w") as layer:
            for directory in ("dist", "dist-server", "migrations"):
                # Hide old generated files, including AppleDouble metadata, in
                # lower image layers before adding this complete replacement.
                opaque = tarfile.TarInfo("app/" + directory + "/.wh..wh..opq")
                opaque.mode = 0o644
                layer.addfile(opaque)
                for path in sorted(pathlib.Path(directory).rglob("*")):
                    if path.is_file() and not any(
                        part.startswith("._") or part == ".DS_Store"
                        for part in path.parts
                    ):
                        info = layer.gettarinfo(str(path), "app/" + str(path))
                        info.uid = info.gid = 1000
                        info.uname = info.gname = "node"
                        info.mode = 0o644
                        info.pax_headers = {}
                        with path.open("rb") as file:
                            layer.addfile(info, file)
        patch.seek(0)
        digest = hashlib.file_digest(patch, "sha256").hexdigest()
        config["rootfs"]["diff_ids"].append("sha256:" + digest)
        config["created"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        config["history"].append({"created": config["created"], "created_by": "Jorik code-only update; unchanged ARM64 runtime and dependencies"})
        encoded = json.dumps(config, separators=(",", ":")).encode()
        image_id = hashlib.sha256(encoded).hexdigest()
        names = []
        with gzip.open(args.output, "wb", compresslevel=1) as compressed, tarfile.open(fileobj=compressed, mode="w|") as target:
            add_bytes(target, image_id + ".json", encoded)
            for index, name in enumerate(manifest["Layers"]):
                with tempfile.TemporaryFile() as raw:
                    with gzip.GzipFile(fileobj=source.extractfile(name)) as data:
                        while chunk := data.read(1048576):
                            raw.write(chunk)
                    raw.seek(0)
                    old_digest = hashlib.file_digest(raw, "sha256").hexdigest()
                    assert "sha256:" + old_digest == config["rootfs"]["diff_ids"][index]
                    path = old_digest + "/layer.tar"
                    names.append(path)
                    info = tarfile.TarInfo(path)
                    info.size = raw.seek(0, 2)
                    raw.seek(0)
                    target.addfile(info, raw)
            path = digest + "/layer.tar"
            names.append(path)
            info = tarfile.TarInfo(path)
            info.size = patch.seek(0, 2)
            patch.seek(0)
            target.addfile(info, patch)
            add_bytes(target, "manifest.json", json.dumps([{"Config": image_id + ".json", "RepoTags": [args.image], "Layers": names}]).encode())
        pathlib.Path(args.output).chmod(0o600)
        pathlib.Path(args.output + ".image-id").write_text("sha256:" + image_id + "\n")
        print("Verified image: sha256:" + image_id)
