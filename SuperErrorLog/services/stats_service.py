from datetime import datetime
from typing import Any

from SuperErrorLog.database.models import ErrorLogDatabase


class StatsService:
    """Read-side statistics for the family dashboard."""

    def __init__(self, db: ErrorLogDatabase):
        self.db = db

    def get_summary(self, now: datetime | None = None) -> dict[str, Any]:
        return {
            "pending_count": self.db.count_pending(),
            "today_due_count": self.db.count_due_by_end_of_day(now),
            "top_knowledge_points": self.db.top_knowledge_points(),
            "repeated_error_reasons": self.db.repeated_error_reasons(),
            "recent_reviews": self.db.recent_review_records(),
        }
