#!/usr/bin/env python3
"""
Fetch WETH/USDC 0.05% pool (0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640) data
from BigQuery via demeter-fetch, then split into public / private windows.

PUBLIC:  2025-06-01 -> 2025-06-03  (3 days)
PRIVATE: 2025-06-04 -> 2025-06-05  (2 days)

Run with the venv python:
  .demeter-venv/bin/python fetch_data.py
"""

import os
import shutil
from datetime import date

# Must be set BEFORE importing google.cloud.bigquery (which demeter_fetch imports)
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = (
    "/Users/lukefoster/.config/gcloud/legacy_credentials"
    "/bq-script@honeycomb-499305.iam.gserviceaccount.com/adc.json"
)
os.environ["GOOGLE_CLOUD_PROJECT"] = "honeycomb-499305"

from demeter_fetch import (
    Config,
    FromConfig,
    ToConfig,
    ChainType,
    DataSource,
    DappType,
    ToType,
    BigQueryConfig,
    UniswapConfig,
    download_by_config,
)

GRADER_DIR = os.path.dirname(os.path.abspath(__file__))
RAW_TMP = os.path.join(GRADER_DIR, "data", "_raw_tmp")
PUBLIC_DIR = os.path.join(GRADER_DIR, "data", "public")
PRIVATE_DIR = os.path.join(GRADER_DIR, "data", "private")

POOL_ADDR = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640"  # lower-case
CHAIN = ChainType.ethereum
AUTH_FILE = os.environ["GOOGLE_APPLICATION_CREDENTIALS"]

# Date windows
PUBLIC_START = date(2025, 6, 1)
PUBLIC_END   = date(2025, 6, 3)
PRIVATE_START = date(2025, 6, 4)
PRIVATE_END   = date(2025, 6, 5)

ALL_START = PUBLIC_START
ALL_END   = PRIVATE_END


def build_config(start: date, end: date, save_path: str) -> Config:
    from_cfg = FromConfig(
        chain=CHAIN,
        data_source=DataSource.big_query,
        dapp_type=DappType.uniswap,
        start=start,
        end=end,
        uniswap_config=UniswapConfig(
            pool_address=POOL_ADDR,
            ignore_position_id=True,  # skip proxy LP logs (not needed for minute)
        ),
        big_query=BigQueryConfig(auth_file=AUTH_FILE),
    )
    to_cfg = ToConfig(
        type=ToType.minute,
        save_path=save_path,
        multi_process=False,
        skip_existed=True,   # don't re-download if we re-run
        keep_raw=False,
    )
    return Config(from_cfg, to_cfg)


def fetch_all():
    """Fetch all 5 days into RAW_TMP, then split by date."""
    print(f"Fetching {ALL_START} to {ALL_END} into {RAW_TMP} ...")
    cfg = build_config(ALL_START, ALL_END, RAW_TMP)
    files = download_by_config(cfg)
    print(f"Downloaded {len(files)} file(s): {files}")
    return files


def split_windows():
    """Copy files from RAW_TMP into public/ and private/ by date."""
    # demeter filename format (confirmed from UniMinute._get_file_name):
    #   ethereum-<pool_addr>-YYYY-MM-DD.minute.csv
    from datetime import timedelta

    def copy_range(start: date, end: date, dest: str):
        day = start
        copied = []
        while day <= end:
            fname = f"ethereum-{POOL_ADDR}-{day.strftime('%Y-%m-%d')}.minute.csv"
            src = os.path.join(RAW_TMP, fname)
            dst = os.path.join(dest, fname)
            if os.path.exists(src):
                shutil.copy2(src, dst)
                copied.append(dst)
                print(f"  copied {fname} -> {dest}")
            else:
                print(f"  WARNING: {src} not found")
            day += timedelta(days=1)
        return copied

    print("Splitting public window ...")
    pub = copy_range(PUBLIC_START, PUBLIC_END, PUBLIC_DIR)
    print("Splitting private window ...")
    priv = copy_range(PRIVATE_START, PRIVATE_END, PRIVATE_DIR)
    return pub, priv


if __name__ == "__main__":
    fetch_all()
    pub_files, priv_files = split_windows()
    print(f"\nDone. Public files ({len(pub_files)}): {pub_files}")
    print(f"Private files ({len(priv_files)}): {priv_files}")
