from dataclasses import dataclass
from datetime import datetime, timedelta, timezone


@dataclass(frozen=True)
class ReviewSchedule:
    result: str
    mastery_status: str
    next_review_at: datetime


REVIEW_RULES = {
    "known": ("learned", timedelta(days=7)),
    "fuzzy": ("fuzzy", timedelta(days=3)),
    "wrong": ("wrong_again", timedelta(days=1)),
}


def schedule_next_review(
    result: str,
    now: datetime | None = None,
) -> ReviewSchedule:
    if result not in REVIEW_RULES:
        raise ValueError("result must be one of: known, fuzzy, wrong")

    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)

    mastery_status, interval = REVIEW_RULES[result]
    return ReviewSchedule(
        result=result,
        mastery_status=mastery_status,
        next_review_at=current + interval,
    )
