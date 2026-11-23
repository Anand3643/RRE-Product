"""Document numbering. The UPDATE takes a row lock (PostgreSQL) / write lock (SQLite) until the caller's transaction
ends, so two concurrent requests can never receive the same number. Combined with the unique constraint on each
document's (org_id, number) this makes duplicate order numbers impossible."""
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from .models import NumberSequence

PREFIX = {"SO": "SO", "PO": "PO", "PKG": "PKG", "SHP": "SHP", "ADJ": "ADJ", "GRN": "GRN", "CUS": "CUS", "VEN": "VEN",
          "PAY": "PAY", "TR": "TR"}


def next_number(db, org_id: int, doc_type: str) -> str:
    where = (NumberSequence.org_id == org_id, NumberSequence.doc_type == doc_type)
    for _ in range(3):
        res = db.execute(update(NumberSequence).where(*where).values(next_value=NumberSequence.next_value + 1)
                         .execution_options(synchronize_session=False))
        if res.rowcount == 1:
            mine = db.scalar(select(NumberSequence.next_value).where(*where)) - 1
            return f"{PREFIX[doc_type]}-{mine:05d}"
        try:  # first use for this org/type (or a concurrent creator won the race: retry the UPDATE)
            with db.begin_nested():
                db.add(NumberSequence(org_id=org_id, doc_type=doc_type, next_value=1))
        except IntegrityError:
            pass
    raise RuntimeError("could not allocate a document number")