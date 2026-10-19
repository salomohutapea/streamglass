from PyInstaller.utils.hooks import collect_all

datas, binaries, hiddenimports = collect_all('mitmproxy')
# The pinned streaming extension checks and compiles the installed method source.
module_collection_mode = {'mitmproxy': 'pyz+py'}
