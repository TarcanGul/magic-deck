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
