"""ZipLogger Python SDK — a standard-library-only logging handler.

Usage::

    import logging
    from ziplogger import ZipLoggerHandler

    logging.getLogger().addHandler(ZipLoggerHandler(
        endpoint="https://logs.yourcompany.com",
        api_key="zk_...",
    ))
"""

from .handler import ZipLoggerHandler

__all__ = ["ZipLoggerHandler"]
__version__ = "0.1.0"
