# home-manager: a systemd user service with its socket on Linux, and a
# LaunchAgent on macOS.
package:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.oneharness;
  command = [
    (lib.getExe cfg.package)
    "server"
    "run"
  ]
  ++ cfg.extraArgs;
  path = lib.makeBinPath cfg.path;
in
{
  options.services.oneharness = import ./options.nix { inherit lib pkgs package; };

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      { home.packages = [ cfg.package ]; }

      (lib.mkIf pkgs.stdenv.hostPlatform.isLinux {
        systemd.user.sockets.oneharness = {
          Unit.Description = "1harness server socket";
          Socket = {
            ListenStream = "%t/1harness/server.sock";
            SocketMode = "0600";
            DirectoryMode = "0700";
          };
          Install.WantedBy = [ "sockets.target" ];
        };
        systemd.user.services.oneharness = {
          Unit = {
            Description = "1harness server";
            Requires = [ "oneharness.socket" ];
            After = [ "oneharness.socket" ];
          };
          Service = {
            Type = "simple";
            EnvironmentFile = "-%h/.config/1harness/server.env";
            Environment =
              lib.optional (cfg.path != [ ]) "PATH=${path}:/run/current-system/sw/bin"
              ++ lib.mapAttrsToList (name: value: "${name}=${value}") cfg.environment;
            ExecStart = lib.escapeShellArgs command;
            Restart = "on-failure";
            RestartSec = "5s";
            TimeoutStopSec = "30s";
          };
        };
      })

      (lib.mkIf pkgs.stdenv.hostPlatform.isDarwin {
        launchd.agents.oneharness = {
          enable = true;
          config = {
            ProgramArguments = command;
            EnvironmentVariables =
              cfg.environment
              // lib.optionalAttrs (cfg.path != [ ]) { PATH = "${path}:/usr/bin:/bin:/usr/sbin:/sbin"; };
            KeepAlive = true;
            RunAtLoad = true;
            ProcessType = "Interactive";
            StandardOutPath = "${config.home.homeDirectory}/Library/Logs/1harness-server.log";
            StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/1harness-server.log";
          };
        };
      })
    ]
  );
}
