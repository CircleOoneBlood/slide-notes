"""Run the notebook engine with a workspace-owned interpreter over an inherited socket."""
import sys
import importlib.util
import os
from pathlib import Path
import socket
from multiprocessing.connection import Connection

if __name__ == '__main__' and sys.argv[1] == '--connect':
    secret = bytes.fromhex(os.environ.pop('SLIDE_NOTES_WORKER_AUTHKEY'))
    with socket.create_connection(('127.0.0.1', int(sys.argv[2])), timeout=5) as channel:
        channel.sendall(secret)
        acknowledgement = b''
        while len(acknowledgement) < 2:
            block = channel.recv(2 - len(acknowledgement))
            if not block: raise ConnectionError('Kernel connection closed')
            acknowledgement += block
        if acknowledgement != b'OK': raise ConnectionError('Kernel connection rejected')
        channel.settimeout(None)
        connection = Connection(channel.detach())
    cwd = sys.argv[3]
elif __name__ == '__main__':
    connection = Connection(int(sys.argv[1]))
    cwd = sys.argv[2]

# Load only the shipped application package. Adding its parent to sys.path would
# put the desktop's site-packages ahead of the workspace interpreter's packages.
package_root = Path(__file__).resolve().parents[1]
package_spec = importlib.util.spec_from_file_location(
    'slide_notes', package_root / '__init__.py',
    submodule_search_locations=[str(package_root)],
)
package = importlib.util.module_from_spec(package_spec)
sys.modules['slide_notes'] = package
package_spec.loader.exec_module(package)
from slide_notes.notebook.runtime import worker

if __name__ == '__main__':
    worker(connection, cwd)
