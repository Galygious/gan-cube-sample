import { KPattern } from 'cubing/kpuzzle';
import { Alg } from 'cubing/alg';

export interface CFOPStep {
    name: string;
    moves: string;
}

export class CFOPSolver {
    private allowedMoves = ["U", "U'", "U2", "D", "D'", "D2", "L", "L'", "L2", "R", "R'", "R2", "F", "F'", "F2", "B", "B'", "B2"];

    constructor() {
    }

    static async create(): Promise<CFOPSolver> {
        return new CFOPSolver();
    }

    async solve(pattern: KPattern): Promise<CFOPStep[]> {
        const steps: CFOPStep[] = [];
        let currentPattern = pattern;

        // 1. Cross (D face edges: 4, 5, 6, 7)
        console.log("Solving Cross...");
        const crossMoves = this.bfs(currentPattern, (p) => this.isCrossSolved(p), 5);
        if (crossMoves) {
            steps.push({ name: "Cross", moves: crossMoves.length > 0 ? crossMoves.join(" ") : "Already Solved" });
            currentPattern = currentPattern.applyAlg(Alg.fromString(crossMoves.join(" ")));
        } else {
            steps.push({ name: "Cross", moves: "Search failed (try manually solving cross first)" });
        }

        // 2. F2L
        steps.push({ name: "F2L 1-4", moves: "Intuitive F2L: Solve 4 corner-edge pairs into the first two layers." });
        
        // 3. OLL (Orientation of the Last Layer)
        // You can add more cases here by checking the top layer pattern
        steps.push({ name: "OLL", moves: "Orient Last Layer: Use an algorithm like F R U R' U' F' to get the top cross, then orient corners." });
        
        // 4. PLL (Permutation of the Last Layer)
        // You can add more cases here by checking the corner/edge positions
        steps.push({ name: "PLL", moves: "Permute Last Layer: Use an algorithm like the T-Perm (R U R' U' R' F R2 U' R' U' R U R' F') to finish." });

        return steps;
    }

    private isCrossSolved(pattern: KPattern): boolean {
        const edges = pattern.patternData["EDGES"];
        // Cross edges are 4 (DF), 5 (DR), 6 (DB), 7 (DL)
        for (let i = 4; i <= 7; i++) {
            if (edges.pieces[i] !== i || edges.orientation[i] !== 0) {
                return false;
            }
        }
        return true;
    }

    private bfs(startPattern: KPattern, isGoal: (p: KPattern) => boolean, maxDepth: number): string[] | null {
        if (isGoal(startPattern)) return [];

        let queue: { pattern: KPattern, moves: string[] }[] = [{ pattern: startPattern, moves: [] }];
        let visited = new Set<string>();
        visited.add(this.getPatternHash(startPattern, "EDGES")); // Only hash edges for cross

        let depth = 0;
        while (queue.length > 0 && depth < maxDepth) {
            let nextQueue: { pattern: KPattern, moves: string[] }[] = [];
            for (const state of queue) {
                for (const move of this.allowedMoves) {
                    const nextPattern = state.pattern.applyAlg(Alg.fromString(move));
                    if (isGoal(nextPattern)) {
                        return [...state.moves, move];
                    }
                    const hash = this.getPatternHash(nextPattern, "EDGES");
                    if (!visited.has(hash)) {
                        visited.add(hash);
                        nextQueue.push({ pattern: nextPattern, moves: [...state.moves, move] });
                    }
                }
            }
            queue = nextQueue;
            depth++;
            console.log(`BFS depth ${depth}, states: ${queue.length}`);
        }

        return null;
    }

    private getPatternHash(pattern: KPattern, orbit: string): string {
        return pattern.patternData[orbit].pieces.join(",") + "|" + pattern.patternData[orbit].orientation.join(",");
    }
}
