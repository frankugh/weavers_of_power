#!/usr/bin/env sh
set -eu

TAG="${TAG:-weavers-of-power:local}"
NAME="${NAME:-weavers-of-power}"
PORT="${PORT:-8080}"
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is not installed. Install and start Docker Desktop." >&2
    exit 1
fi

if ! docker info >/dev/null 2>&1; then
    echo "The Docker engine is unavailable. Start Docker Desktop and try again." >&2
    exit 1
fi

if ! docker image inspect "$TAG" >/dev/null 2>&1; then
    docker build --tag "$TAG" .
fi

if docker container inspect "$NAME" >/dev/null 2>&1; then
    if [ "$(docker container inspect --format '{{.State.Running}}' "$NAME")" = "true" ]; then
        echo "Container '$NAME' is already running."
    else
        docker start "$NAME" >/dev/null
    fi
else
    docker run \
        --detach \
        --name "$NAME" \
        --restart unless-stopped \
        --publish "$PORT:8080" \
        --volume weavers-data:/app/data \
        --volume weavers-saves:/app/saves \
        --volume weavers-custom-art:/app/images/Playing_Characters/extra/custom \
        "$TAG" >/dev/null
fi

echo
echo "Weavers of Power is running at http://localhost:$PORT"
echo "Stop: docker stop $NAME"
echo "Logs: docker logs --follow $NAME"
