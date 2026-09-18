#!/usr/bin/env python3
"""Run the ECS task definitions Terraform registered, in local Docker.

The simulator accepts the task definitions but runs nothing. This reads them
back from it and starts each container the way Fargate would: same image,
command, environment, secrets (resolved from the simulated SSM), ports and
service-discovery names. The database is a pgvector Postgres 16 answering on
the RDS address Terraform wrote into DATABASE_URL, with its password; Redis
answers on the address the simulation's override gives ElastiCache.

Then it runs the migration task and checks every service's health endpoint,
and the gateway's /ready (which lists any canonical view a migration missed).

Two settings are added that the real task definitions do not carry, and both
only stop the simulation calling the outside world with fake keys:
WATTSTEER_RAG_INDEX_ON_BOOT=0 and WATTSTEER_REFRESH=off.
"""

import json
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
AWS = str(HERE.parent / "scripts" / "aws.sh")
NETWORK = "wattsteer-ecs-sim"
NAMESPACE = "wattsteer.internal"
SERVICES = ["web", "api", "worker", "ml", "rag"]
SIM_ONLY_ENV = {"WATTSTEER_RAG_INDEX_ON_BOOT": "0", "WATTSTEER_REFRESH": "off"}


def run(*args: str, check: bool = True) -> str:
    result = subprocess.run(args, capture_output=True, text=True)
    if check and result.returncode != 0:
        sys.exit(f"failed: {' '.join(args[:4])}…\n{result.stderr[-2000:]}")
    # Both streams: drizzle-kit reports its result on stderr.
    return result.stdout + result.stderr


def aws_json(*args: str) -> dict:
    result = subprocess.run([AWS, *args, "--output", "json"], capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(f"failed: aws {' '.join(args[:3])}\n{result.stderr[-2000:]}")
    return json.loads(result.stdout)


def container(family: str) -> dict:
    definition = aws_json("ecs", "describe-task-definition", "--task-definition", f"wattsteer-{family}")
    return definition["taskDefinition"]["containerDefinitions"][0]


def resolve_secrets(definition: dict) -> dict:
    values = {}
    for secret in definition.get("secrets", []):
        name = secret["valueFrom"].split(":parameter", 1)[1]
        parameter = aws_json("ssm", "get-parameter", "--name", name, "--with-decryption")
        values[secret["name"]] = parameter["Parameter"]["Value"]
    return values


def docker_run(name: str, definition: dict, aliases: list[str], detach: bool = True) -> str:
    env = {e["name"]: e["value"] for e in definition.get("environment", [])}
    env.update(resolve_secrets(definition))
    env.update(SIM_ONLY_ENV)
    args = ["docker", "run", "--name", f"ecs-sim-{name}", "--network", NETWORK]
    for alias in aliases:
        args += ["--network-alias", alias]
    for key, value in env.items():
        args += ["-e", f"{key}={value}"]
    for mount in definition.get("mountPoints", []):
        args += ["-v", f"ecs-sim-{mount['sourceVolume']}:{mount['containerPath']}"]
    args += ["-d"] if detach else ["--rm"]
    args += [definition["image"], *(definition.get("command") or [])]
    return run(*args, check=False) if not detach else run(*args)


def wait_healthy(label: str, url: str, timeout: int = 180) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        probe = subprocess.run(
            ["docker", "run", "--rm", "--network", NETWORK, "curlimages/curl:8.10.1", "-fsS", "-m", "5", url],
            capture_output=True, text=True,
        )
        if probe.returncode == 0:
            print(f"  ok   {label:8} {url}  {probe.stdout.strip()[:90]}")
            return
        time.sleep(5)
    logs = run("docker", "logs", "--tail", "40", f"ecs-sim-{label}", check=False)
    sys.exit(f"  FAIL {label} {url} did not answer in {timeout}s\n{logs}")


def cleanup() -> None:
    names = [f"ecs-sim-{n}" for n in [*SERVICES, "postgres", "redis"]]
    subprocess.run(["docker", "rm", "-f", *names], capture_output=True)
    subprocess.run(["docker", "network", "rm", NETWORK], capture_output=True)


def main() -> None:
    cleanup()
    run("docker", "network", "create", NETWORK)

    api = container("api")
    database = urlparse(resolve_secrets(api)["DATABASE_URL"])
    print(f"database: postgres at {database.hostname} (the RDS address Terraform wrote)")
    run("docker", "run", "-d", "--name", "ecs-sim-postgres", "--network", NETWORK,
        "--network-alias", database.hostname,
        "-e", "POSTGRES_USER=wattsteer", "-e", f"POSTGRES_PASSWORD={database.password}",
        "-e", "POSTGRES_DB=wattsteer", "pgvector/pgvector:pg16")
    run("docker", "run", "-d", "--name", "ecs-sim-redis", "--network", NETWORK,
        "--network-alias", "redis", "redis:7-alpine")
    for _ in range(60):
        if subprocess.run(["docker", "exec", "ecs-sim-postgres", "pg_isready", "-U", "wattsteer"],
                          capture_output=True).returncode == 0:
            break
        time.sleep(1)
    time.sleep(2)

    print("migration task:")
    output = docker_run("migrate", container("migrate"), [], detach=False)
    if "migrations applied successfully" not in output:
        sys.exit(f"  FAIL migration\n{output[-2000:]}")
    print("  ok   migrations applied")

    print("services:")
    for name in SERVICES:
        docker_run(name, container(name), [name, f"{name}.{NAMESPACE}"])

    wait_healthy("web", "http://web:8080/healthz")
    wait_healthy("api", "http://api:3000/health")
    wait_healthy("ml", f"http://ml.{NAMESPACE}:8000/health")
    wait_healthy("rag", f"http://rag.{NAMESPACE}:8082/health")
    wait_healthy("api", "http://api:3000/ready")
    state = run("docker", "inspect", "-f", "{{.State.Status}}", "ecs-sim-worker").strip()
    if state != "running":
        sys.exit(f"  FAIL worker is {state}\n{run('docker', 'logs', '--tail', '40', 'ecs-sim-worker', check=False)}")
    print("  ok   worker   running")

    if "--keep" not in sys.argv:
        cleanup()
    print("ECS task definitions: every container started and answered")


if __name__ == "__main__":
    main()
