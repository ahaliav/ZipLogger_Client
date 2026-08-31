"""ZipLogger Python SDK — a standard-library-only logging handler.

Usage::

    import logging
    from ziplogger import ZipLoggerHandler

    logging.getLogger().addHandler(ZipLoggerHandler(
        endpoint="https://app.ziplogger.ai",
        api_key="zk_...",
    ))
"""

from .handler import ZipLoggerHandler

__all__ = ["ZipLoggerHandler"]

# Read from the installed distribution rather than repeating the number here. A literal
# drifts the moment a release bumps pyproject.toml and forgets this line, which is exactly
# what happened in 0.4.0: the wheel shipped as 0.4.0 while __version__ still said 0.3.3.
try:  # pragma: no cover - trivial, and the fallback is only hit when running from source
    from importlib.metadata import PackageNotFoundError, version as _distribution_version

    __version__ = _distribution_version("ziplogger")
except (ImportError, PackageNotFoundError):  # running from a source checkout, not installed
    __version__ = "0.0.0.dev0"
