{
  description = "Ambiente de desenvolvimento para o Obol (Nuxt + Elysia)";

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
          ];

          shellHook = ''
            echo "🚀 Bem-vindo ao ambiente de desenvolvimento do Obol!"
            echo "📦 Ferramentas disponíveis:"
            echo "  - Node.js $(node -v)"
            echo "  - Bun $(bun -v)"
            echo ""
            echo "💡 Para resolver o erro do Docker (falta de arquivos de lock), faça o setup inicial:"
            echo "  1. cd frontend && npm install && cd .."
            echo "  2. cd bff && bun install && cd .."
            echo "  3. docker-compose -f docker-compose.yml up -d --build"
          '';
        };
      }
    );
}
