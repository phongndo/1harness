# NixOS: a systemd user service, started by its socket on the first
# connection, for every user who logs in.
package:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.oneharness;
in
{
  options.services.oneharness = import ./options.nix { inherit lib pkgs package; };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];

    systemd.user.sockets.oneharness = {
      description = "1harness server socket";
      wantedBy = [ "sockets.target" ];
      listenStreams = [ "%t/1harness/server.sock" ];
      socketConfig = {
        SocketMode = "0600";
        DirectoryMode = "0700";
      };
    };

    systemd.user.services.oneharness = {
      description = "1harness server";
      requires = [ "oneharness.socket" ];
      after = [ "oneharness.socket" ];
      path = cfg.path;
      environment = cfg.environment;
      serviceConfig = {
        Type = "simple";
        EnvironmentFile = "-%h/.config/1harness/server.env";
        ExecStart = lib.escapeShellArgs (
          [
            (lib.getExe cfg.package)
            "server"
            "run"
          ]
          ++ cfg.extraArgs
        );
        Restart = "on-failure";
        RestartSec = "5s";
        TimeoutStopSec = "30s";
      };
    };
  };
}
