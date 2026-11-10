//! Юнит-тесты узла. Сеть им не нужна: тесты пересылки (node.zig) обходятся сокетами на петле.
test {
    _ = @import("ws.zig");
    _ = @import("stun.zig");
    _ = @import("dtls.zig");
    _ = @import("sctp.zig");
    _ = @import("mqtt.zig");
    _ = @import("room.zig");
    _ = @import("signal.zig");
    _ = @import("rtp.zig");
    _ = @import("srtp.zig");
    _ = @import("rtcp.zig");
    _ = @import("sdp.zig");
    _ = @import("leg.zig");
    _ = @import("netif.zig");
    _ = @import("node.zig");
}
