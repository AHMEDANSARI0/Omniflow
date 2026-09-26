"""Structural tests for desktop alerts (Phase 46)."""
import sys

import test_lib
from test_lib import check, summary, portal_page_source

page_src = portal_page_source("conversations")

check("alert state", 'const [alertEnabled, setAlertEnabled] = useState(false);' in page_src)
check("alert total ref", "const alertTotalRef = useRef(0);" in page_src)
check("toggle fn", "async function toggleAlert()" in page_src)
check("localStorage persisted", 'window.localStorage.setItem("ofl_desktop_alert", next ? "1" : "0");' in page_src)
check("permission requested", "await Notification.requestPermission();" in page_src)
check("effect watches counts", "}, [chipCounts, alertEnabled, soundEnabled]);" in page_src)
check("fires only when hidden", "total > alertTotalRef.current && document.hidden" in page_src)
check("fires only when granted", 'Notification.permission === "granted"' in page_src)
check("mount reads stored pref", 'window.localStorage.getItem("ofl_desktop_alert") === "1"' in page_src)
check("alerts button", '{alertEnabled ? "Alerts on" : "Alerts off"}' in page_src)

failures = summary("desktop_alert")
sys.exit(1 if failures else 0)
