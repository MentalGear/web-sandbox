# Real pointer input for research 33's real-input.mjs: X server events through the XTest extension (libXtst), so the
# browser receives the input from the X server as from a mouse, not from Playwright's protocol.
#
#   python3 -I docs/research/33_link_href/xtest.py move X Y | down | up | rdown | rup
#
# One action per call, on the display named by $DISPLAY (xvfb-run sets it).
import ctypes
import sys

x11 = ctypes.CDLL('libX11.so.6')
xtst = ctypes.CDLL('libXtst.so.6')
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]

dpy = x11.XOpenDisplay(None)
if not dpy:
    sys.exit('no display')
action = sys.argv[1]
if action == 'move':
    xtst.XTestFakeMotionEvent(dpy, -1, int(float(sys.argv[2])), int(float(sys.argv[3])), 0)
elif action in ('down', 'up'):
    xtst.XTestFakeButtonEvent(dpy, 1, 1 if action == 'down' else 0, 0)
elif action in ('rdown', 'rup'):
    xtst.XTestFakeButtonEvent(dpy, 3, 1 if action == 'rdown' else 0, 0)
x11.XFlush(dpy)
x11.XCloseDisplay(dpy)
