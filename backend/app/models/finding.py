from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import JSON, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Finding(Base):
    __tablename__ = "findings"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    scan_id: Mapped[str] = mapped_column(String(36), ForeignKey("scans.id"), index=True)
    source: Mapped[str] = mapped_column(String(32))
    kind: Mapped[str] = mapped_column(String(32))
    severity: Mapped[str] = mapped_column(String(16), default="info")
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
