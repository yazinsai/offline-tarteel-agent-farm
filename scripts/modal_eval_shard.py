import os
import sys
from pathlib import Path

import modal


app = modal.App("offline-tarteel-agent-farm-eval")


@app.local_entrypoint()
def main(
    bundle: str,
    run_command: str,
    artifact: str,
    cpu: int = 4,
    memory_mb: int = 8192,
    image: str = "node:22-bookworm",
    timeout_seconds: int = 21600,
) -> None:
    bundle_path = Path(bundle).resolve()
    if not bundle_path.exists():
        raise FileNotFoundError(bundle_path)

    sandbox = modal.Sandbox.create(
        "sleep",
        "infinity",
        app=app,
        image=modal.Image.from_registry(image).apt_install("ffmpeg", "cpulimit"),
        cpu=cpu,
        memory=f"{memory_mb}Mi",
        timeout=timeout_seconds,
    )

    remote_bundle = f"/tmp/{bundle_path.name}"
    try:
        print(f"[modal-shard] phase=upload bundle={bundle_path}", flush=True)
        sandbox.filesystem.copy_from_local(bundle_path, remote_bundle)

        artifact_dir = os.path.dirname(artifact)
        steps = [
            "set -euo pipefail",
            "trap 'code=$?; echo \"[modal-shard] phase=error exit=${code} command=${BASH_COMMAND}\" >&2' ERR",
            "echo '[modal-shard] phase=prepare clean-workspace'",
            "rm -rf /tmp/agent-farm-eval",
            "mkdir -p /tmp/agent-farm-eval",
            "echo '[modal-shard] phase=prepare extract-bundle'",
            f"tar -xzf {sh(remote_bundle)} -C /tmp/agent-farm-eval",
            "cd /tmp/agent-farm-eval/web/frontend",
            "echo '[modal-shard] phase=deps npm-install'",
            "[ -d node_modules ] || npm install",
            *( [f"mkdir -p {sh(artifact_dir)}"] if artifact_dir else [] ),
            "echo '[modal-shard] phase=stability start'",
            run_command,
            "echo '[modal-shard] phase=artifact encode'",
            "printf '\\n__AGENT_FARM_ARTIFACT_BEGIN__\\n'",
            f"base64 -w 0 {sh(artifact)}",
            "printf '\\n__AGENT_FARM_ARTIFACT_END__\\n'",
            "echo '[modal-shard] phase=done'",
        ]
        script = "\n".join(steps)

        process = sandbox.exec(
            "bash",
            "-lc",
            f"{script} 2>&1",
            timeout=timeout_seconds,
        )
        output = process.stdout.read()
        if output:
            print(output, end="")
        process.wait()
        if process.returncode != 0:
            raise SystemExit(process.returncode)
    finally:
        sandbox.terminate()


def sh(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"
