import os
import shutil
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
        image=modal.Image.from_registry(image),
        cpu=cpu,
        memory=memory_mb,
        timeout=timeout_seconds,
    )

    remote_bundle = f"/tmp/{bundle_path.name}"
    try:
        with bundle_path.open("rb") as source, sandbox.open(remote_bundle, "wb") as target:
            shutil.copyfileobj(source, target)

        artifact_dir = os.path.dirname(artifact)
        steps = [
            "set -euo pipefail",
            "rm -rf /tmp/agent-farm-eval",
            "mkdir -p /tmp/agent-farm-eval",
            f"tar -xzf {sh(remote_bundle)} -C /tmp/agent-farm-eval",
            "cd /tmp/agent-farm-eval/web/frontend",
            "apt-get update >/dev/null",
            "apt-get install -y ffmpeg cpulimit >/dev/null",
            "[ -d node_modules ] || npm install",
            *( [f"mkdir -p {sh(artifact_dir)}"] if artifact_dir else [] ),
            run_command,
            "printf '\\n__AGENT_FARM_ARTIFACT_BEGIN__\\n'",
            f"base64 -w 0 {sh(artifact)}",
            "printf '\\n__AGENT_FARM_ARTIFACT_END__\\n'",
        ]
        script = " && ".join(steps)

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
