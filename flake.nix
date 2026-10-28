{
  description = "Reproducible development environment for Obol (Nuxt, Elysia, PocketBase and Electrobun)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs_22
            bun
            docker-compose
            unzip
          ];

          shellHook = ''
            echo "Obol development environment"
            echo "Node.js: $(node --version)"
            echo "Bun: $(bun --version)"
            echo ""
            echo "Install app dependencies: (cd app && npm ci)"
            echo "Install server dependencies: (cd server && bun install)"
            echo "Install desktop dependencies: (cd desktop && bun install)"
            echo "Run the hosted stack: docker compose up -d --build"
            echo "Run the local desktop app: (cd desktop && bun run eb:dev)"
          '';
        };
      }
    );
}
