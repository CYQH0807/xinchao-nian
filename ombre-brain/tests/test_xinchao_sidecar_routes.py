import json

import pytest

import web.buckets as buckets_web


class FakeMCP:
    """Capture custom routes without starting the MCP server."""

    def __init__(self):
        self.routes = {}

    def custom_route(self, path, methods):
        def decorator(handler):
            for method in methods:
                self.routes[(method, path)] = handler
            return handler

        return decorator


class Request:
    """Minimal request shape used by the sidecar-only compatibility routes."""

    def __init__(self, *, bucket_id="", token=None):
        self.path_params = {"bucket_id": bucket_id}
        self.headers = {
            "Authorization": f"Bearer {token}" if token is not None else "",
        }


class FakeBucketManager:
    """Provide the two read operations required by the compatibility routes."""

    def __init__(self, buckets):
        self.buckets = list(buckets)

    async def get(self, bucket_id):
        return next((bucket for bucket in self.buckets if bucket["id"] == bucket_id), None)

    async def list_all(self, *, include_archive=False):
        assert include_archive is True
        return list(self.buckets)


class FakeDecayEngine:
    """Return deterministic scores for star-map ordering."""

    def calculate_score(self, metadata):
        return metadata.get("test_score", 0.0)


def _payload(response):
    return json.loads(response.body.decode("utf-8"))


def _install(monkeypatch, buckets):
    token = "local-sidecar-token-" + "x" * 20
    monkeypatch.setenv("OMBRE_MCP_SERVICE_TOKEN", token)
    monkeypatch.setattr(buckets_web.sh, "bucket_mgr", FakeBucketManager(buckets), raising=False)
    monkeypatch.setattr(buckets_web.sh, "decay_engine", FakeDecayEngine(), raising=False)
    mcp = FakeMCP()
    buckets_web.register(mcp)
    return mcp, token


@pytest.mark.asyncio
async def test_sidecar_routes_require_the_dedicated_token(monkeypatch):
    mcp, token = _install(monkeypatch, [])

    preview = await mcp.routes[("GET", "/api/bucket-preview/{bucket_id}")](
        Request(bucket_id="missing", token=token[:-1])
    )
    star_map = await mcp.routes[("GET", "/api/bucket-map")](Request(token=None))

    assert preview.status_code == 401
    assert star_map.status_code == 401
    assert _payload(preview) == {"error": "Unauthorized"}
    assert _payload(star_map) == {"error": "Unauthorized"}


@pytest.mark.asyncio
async def test_sidecar_bucket_map_is_metadata_only_and_sorted(monkeypatch):
    mcp, token = _install(
        monkeypatch,
        [
            {
                "id": "low",
                "metadata": {
                    "name": "低分",
                    "domain": ["生活"],
                    "tags": ["日常"],
                    "test_score": 2.0,
                    "importance": 3,
                },
                "content": "不能进入星图正文",
            },
            {
                "id": "high",
                "metadata": {
                    "name": "高分",
                    "type": "permanent",
                    "pinned": True,
                    "test_score": 8.0,
                    "why_remembered": "不应输出",
                },
                "content": "不能进入星图正文",
            },
            {
                "id": "deleted",
                "metadata": {"deleted_at": "2026-08-27T00:00:00Z", "test_score": 99.0},
                "content": "已归档不进入星图",
            },
        ],
    )

    response = await mcp.routes[("GET", "/api/bucket-map")](Request(token=token))
    payload = _payload(response)

    assert response.status_code == 200
    assert payload["total"] == 2
    assert payload["stats"] == {"pinned": 1, "dynamic": 1, "archived": 0}
    assert [star["id"] for star in payload["stars"]] == ["high", "low"]
    assert all("content" not in star for star in payload["stars"])
    assert all("why_remembered" not in star for star in payload["stars"])


@pytest.mark.asyncio
async def test_sidecar_preview_is_short_and_strips_wikilinks(monkeypatch):
    mcp, token = _install(
        monkeypatch,
        [
            {
                "id": "memory-1",
                "metadata": {},
                "content": "\n".join(
                    [f"第 {index} 行 [[显示名]]" for index in range(1, 10)]
                ),
            }
        ],
    )

    response = await mcp.routes[("GET", "/api/bucket-preview/{bucket_id}")](
        Request(bucket_id="memory-1", token=token)
    )
    payload = _payload(response)

    assert response.status_code == 200
    assert payload["id"] == "memory-1"
    assert payload["lineCount"] == 7
    assert payload["truncated"] is True
    assert "[[" not in payload["preview"]
    assert payload["preview"].splitlines()[-1] == "第 7 行 显示名"
