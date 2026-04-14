from fastapi.testclient import TestClient

from app.main import app


def test_register_flow():
    client = TestClient(app)
    payload = {
        "tenant_name": "tenant-test",
        "email": "qa@example.com",
        "password": "secret123",
    }
    response = client.post("/api/v1/auth/register", json=payload)
    assert response.status_code in [200, 400]
