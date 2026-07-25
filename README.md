# Magic Deck

Run the API server with Python 3.13. Install `requirements.txt` before starting `magenta_server.py`. The pinned `aubio==0.4.9` dependency is distributed as source and requires a working C compiler; use a Python 3.13 environment if the host Python version cannot build it. BPM detection intentionally does not fall back to librosa.

NumPy is capped below 2.4 because Magenta's `recurrentgemma` dependency requires it; this also satisfies Numba's requirement for NumPy 2.4 or earlier. If an existing environment has a newer NumPy version, repair it with:

```bash
python -m pip install --force-reinstall "numpy<2.4"
```

If the PyPI release fails to compile against the active Python/NumPy toolchain, install aubio directly from its upstream Git repository:

```bash
pip install -Iv git+https://git.aubio.org/aubio/aubio
```

## Beat-locked generation

Install the Rubber Band command-line utility for the preferred per-beat timing
correction:

```bash
brew install rubberband
```

`magenta_server.py` detects the `rubberband` executable at runtime. If it is not
installed, or if its time-map correction fails, generation continues with
librosa global time-stretching and returns a visible timing warning to the
frontend. Trim/pad is used only for final sample-count cleanup.
