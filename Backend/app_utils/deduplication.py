"""
Image Deduplication Service

FINAL RULES:
1. Same issue + same location (<=50m) → Reject (Already registered)
2. Same issue + different location + similar image → Reject (Duplicate image detected)
3. Same location + different issue → Allow
4. Different location + different image → Allow
"""

from sqlalchemy.orm import Session
from typing import Optional, Tuple
from app_models import ComplaintImage, SubTicket, Ticket
from app_utils.geo import calculate_distance
from app_utils.image_hash import calculate_image_hash, compare_image_hashes

# ---------------- CONFIG ----------------
DEFAULT_DISTANCE_THRESHOLD = 50  # meters
DEFAULT_HASH_THRESHOLD = 5       # perceptual hash distance


def check_duplicate_image(
    db: Session,
    image_bytes: bytes,
    latitude: Optional[float],
    longitude: Optional[float],
    issue_type: Optional[str],
    distance_threshold: float = DEFAULT_DISTANCE_THRESHOLD,
    hash_threshold: int = DEFAULT_HASH_THRESHOLD
) -> Tuple[bool, Optional[str], Optional[dict]]:
    """
    Returns:
    (is_duplicate, reason, existing_info)
    """

    new_hash = calculate_image_hash(image_bytes, use_perceptual=True)

    has_location = (
        latitude is not None and longitude is not None
        and latitude != 0.0 and longitude != 0.0
    )

    # 🔹 Only compare against SAME ISSUE
    query = (
        db.query(ComplaintImage)
        .join(SubTicket, SubTicket.sub_id == ComplaintImage.sub_id)
        .filter(SubTicket.issue_type == issue_type)
        .filter(ComplaintImage.image_hash.isnot(None))
    )

    for existing in query.all():
        distance = None

        # ---------------- LOCATION CHECK ----------------
        if has_location and existing.latitude and existing.longitude:
            distance = calculate_distance(
                latitude,
                longitude,
                existing.latitude,
                existing.longitude
            )

            # ✅ RULE 1: Same issue + same location
            if distance <= distance_threshold:
                ticket_info = _build_ticket_info(db, existing)
                return (
                    True,
                    "This complaint is already registered. Thanks for your concern.",
                    {
                        "id": existing.id,
                        "sub_id": existing.sub_id,
                        "distance_meters": round(distance, 2),
                        "ticket_info": ticket_info
                    }
                )

        # ---------------- IMAGE SIMILARITY CHECK ----------------
        if compare_image_hashes(new_hash, existing.image_hash, hash_threshold):
            # ✅ RULE 2: Same issue + similar image (but far)
            ticket_info = _build_ticket_info(db, existing)
            return (
                True,
                "Duplicate image detected. This issue has already been reported.",
                {
                    "id": existing.id,
                    "sub_id": existing.sub_id,
                    "distance_meters": round(distance, 2) if distance else None,
                    "ticket_info": ticket_info
                }
            )

    # ✅ No conflicts
    return False, None, None


# --------------------------------------------------
# Helper to build clean ticket info
# --------------------------------------------------
def _build_ticket_info(db: Session, image: ComplaintImage) -> Optional[dict]:
    sub_ticket = db.query(SubTicket).filter(
        SubTicket.sub_id == image.sub_id
    ).first()

    if not sub_ticket:
        return None

    ticket = db.query(Ticket).filter(
        Ticket.ticket_id == sub_ticket.ticket_id
    ).first()

    if not ticket:
        return None

    return {
        "ticket_id": ticket.ticket_id,
        "sub_id": sub_ticket.sub_id,
        "issue_type": sub_ticket.issue_type,
        "authority": sub_ticket.authority,
        "status": sub_ticket.status
    }
