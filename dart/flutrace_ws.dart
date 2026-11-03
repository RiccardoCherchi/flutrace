// Copy into a Flutter app so Flutrace can show its WebSocket messages:
//
//   final socket = traceWebSocket(await WebSocket.connect(url), url);
//
// The Dart VM keeps no WebSocket messages, so this posts each one to the
// local VM Service. It does nothing in release builds.
import 'dart:async';
import 'dart:convert';
import 'dart:developer' as developer;
import 'dart:io';

const _eventKind = 'flutrace.ws';

/// Longer text is cut before posting.
const _maxTextLength = 64 * 1024;

int _nextId = 0;

bool get _isDebug {
  var debug = false;
  assert(debug = true);
  return debug;
}

/// Returns [socket] itself in release builds.
WebSocket traceWebSocket(WebSocket socket, Object url) {
  if (!_isDebug) return socket;
  return _TracedWebSocket(socket, url.toString());
}

class _TracedWebSocket extends StreamView<dynamic> implements WebSocket {
  _TracedWebSocket._(this._socket, this._id, this._url, Stream<dynamic> traced)
    : super(traced);

  factory _TracedWebSocket(WebSocket socket, String url) {
    final id = '${++_nextId}';
    _post({'type': 'open', 'id': id, 'url': url});
    late final _TracedWebSocket traced;
    traced = _TracedWebSocket._(
      socket,
      id,
      url,
      socket.map((data) {
        traced._message('in', data);
        return data;
      }),
    );
    socket.done.whenComplete(
      () => _post({
        'type': 'close',
        'id': id,
        'url': url,
        'code': socket.closeCode,
      }),
    );
    return traced;
  }

  final WebSocket _socket;
  final String _id;

  /// Sent with every event, for inspectors that attach mid-stream.
  final String _url;

  static void _post(Map<String, Object?> data) {
    developer.postEvent(_eventKind, {
      ...data,
      'at': DateTime.now().millisecondsSinceEpoch,
    });
  }

  void _message(String direction, Object? data) {
    if (data is String) {
      final truncated = data.length > _maxTextLength;
      _post({
        'type': 'message',
        'id': _id,
        'url': _url,
        'direction': direction,
        'size': utf8.encode(data).length,
        'text': truncated ? data.substring(0, _maxTextLength) : data,
        'binary': false,
        'truncated': truncated,
      });
    } else if (data is List<int>) {
      _post({
        'type': 'message',
        'id': _id,
        'url': _url,
        'direction': direction,
        'size': data.length,
        'binary': true,
        'truncated': false,
      });
    }
  }

  @override
  void add(dynamic data) {
    _message('out', data);
    _socket.add(data);
  }

  @override
  void addUtf8Text(List<int> bytes) {
    _message('out', utf8.decode(bytes, allowMalformed: true));
    _socket.addUtf8Text(bytes);
  }

  @override
  Future addStream(Stream stream) => _socket.addStream(
    stream.map((data) {
      _message('out', data);
      return data;
    }),
  );

  @override
  void addError(Object error, [StackTrace? stackTrace]) =>
      _socket.addError(error, stackTrace);

  @override
  Future close([int? code, String? reason]) => _socket.close(code, reason);

  @override
  Future get done => _socket.done;

  @override
  int? get closeCode => _socket.closeCode;

  @override
  String? get closeReason => _socket.closeReason;

  @override
  String get extensions => _socket.extensions;

  @override
  String? get protocol => _socket.protocol;

  @override
  int get readyState => _socket.readyState;

  @override
  Duration? get pingInterval => _socket.pingInterval;

  @override
  set pingInterval(Duration? interval) => _socket.pingInterval = interval;
}
