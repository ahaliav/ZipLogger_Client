"""Northwind Coffee — recommendations service (Python).

Scores products for a shopper and ships every log line to ZipLogger. The service
runs a synthetic traffic loop so a demo workspace always has live data.

The interesting part for a demo is not the scoring, it is what the logs look like
when something goes wrong: the ZeroDivisionError raised in score() below is a real
exception from a real line, so the stack trace ZipLogger receives resolves to an
actual commit in this repository.
"""

import logging
import os
import random
import time

from ziplogger import ZipLoggerHandler

ENDPOINT = os.environ.get("ZIPLOGGER_ENDPOINT", "https://app.ziplogger.ai")
API_KEY = os.environ.get("ZIPLOGGER_API_KEY", "")
INTERVAL = float(os.environ.get("DEMO_INTERVAL_SECONDS", "4"))

PRODUCTS = [
    ("ETH-YIRG-250", "Ethiopia Yirgacheffe", 18.50),
    ("COL-HUILA-1K", "Colombia Huila 1kg", 42.00),
    ("KEN-AA-250", "Kenya AA", 21.00),
    ("BRZ-SANTOS-500", "Brazil Santos 500g", 15.75),
    ("DECAF-SWP-250", "Swiss Water Decaf", 19.25),
]
SEGMENTS = ["first-time", "subscriber", "wholesale", "lapsed"]

log = logging.getLogger("recommendations")


def score(product, segment, basket_total):
    """Rank one product for one shopper.

    Wholesale shoppers are scored on a different curve. The curve divides by the
    basket total, which is zero for a shopper who has not added anything yet —
    that is the bug this demo reproduces on purpose.
    """
    sku, name, price = product
    affinity = random.uniform(0.2, 0.95)

    if segment == "wholesale":
        # Bug: an empty basket makes this a division by zero.
        return affinity * (price / basket_total) * 10

    return affinity * (1 + price / 100)


def recommend(customer_id, segment, basket_total):
    ranked = []
    for product in PRODUCTS:
        ranked.append((score(product, segment, basket_total), product))
    ranked.sort(reverse=True, key=lambda pair: pair[0])
    return ranked[:3]


def serve_one_request():
    customer_id = f"cust-{random.randint(1000, 9999)}"
    segment = random.choice(SEGMENTS)
    # Wholesale shoppers occasionally arrive with an empty basket, which trips the bug above.
    basket_total = 0.0 if (segment == "wholesale" and random.random() < 0.25) else round(random.uniform(12, 240), 2)
    started = time.time()

    try:
        top = recommend(customer_id, segment, basket_total)
        elapsed_ms = round((time.time() - started) * 1000, 1)

        if elapsed_ms > 40:
            log.warning(
                "Recommendation scoring was slow",
                extra={"customerId": customer_id, "segment": segment, "durationMs": elapsed_ms},
            )

        log.info(
            "Scored %d products for %s",
            len(PRODUCTS),
            customer_id,
            extra={
                "customerId": customer_id,
                "segment": segment,
                "basketTotal": basket_total,
                "durationMs": elapsed_ms,
                "topSku": top[0][1][0],
            },
        )
    except ZeroDivisionError:
        # Logging with exc_info gives ZipLogger the stack trace, which is what drives
        # "which commit broke this?" analysis.
        log.error(
            "Recommendation scoring failed for %s",
            customer_id,
            exc_info=True,
            extra={"customerId": customer_id, "segment": segment, "basketTotal": basket_total},
        )


def main():
    if not API_KEY:
        raise SystemExit("ZIPLOGGER_API_KEY is required")

    handler = ZipLoggerHandler(
        endpoint=ENDPOINT,
        api_key=API_KEY,
        source="recommendations",
        environment=os.environ.get("ZIPLOGGER_ENVIRONMENT", "production"),
        tags=["demo", "python"],
    )
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger().addHandler(handler)

    log.info("Recommendations service started", extra={"products": len(PRODUCTS)})

    try:
        while True:
            serve_one_request()
            time.sleep(INTERVAL)
    except KeyboardInterrupt:
        log.info("Recommendations service stopping")
    finally:
        handler.close()


if __name__ == "__main__":
    main()
