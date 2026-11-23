import { useCallback, useEffect, useMemo, useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
// Este archivo se genera con `anchor build` y se copia a esta carpeta
// (ver README, paso "Copiar el IDL").
import idl from "./idl/tareas.json";

type Tarea = {
  pubkey: PublicKey;
  id: number;
  titulo: string;
  completada: boolean;
};

export default function App() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  const [lista, setLista] = useState<{ nombre: string; activas: number } | null>(null);
  const [tareas, setTareas] = useState<Tarea[]>([]);
  const [nombreLista, setNombreLista] = useState("");
  const [titulo, setTitulo] = useState("");
  const [cargando, setCargando] = useState(false);
  const [mensaje, setMensaje] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);

  // Cliente de Anchor, construido con el IDL y la wallet conectada
  const program = useMemo(() => {
    if (!wallet) return null;
    const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
    return new Program(idl as any, provider) as Program<any>;
  }, [connection, wallet]);

  // PDA de la lista: ["lista", owner]
  const listaPda = useMemo(() => {
    if (!program || !wallet) return null;
    return PublicKey.findProgramAddressSync(
      [Buffer.from("lista"), wallet.publicKey.toBuffer()],
      program.programId
    )[0];
  }, [program, wallet]);

  // PDA de una tarea: ["tarea", lista, id (u32 little-endian)]
  const tareaPda = (id: number) => {
    const idBuf = Buffer.alloc(4);
    idBuf.writeUInt32LE(id);
    return PublicKey.findProgramAddressSync(
      [Buffer.from("tarea"), listaPda!.toBuffer(), idBuf],
      program!.programId
    )[0];
  };

  // LEER: carga la lista y sus tareas desde Devnet
  const cargar = useCallback(async () => {
    if (!program || !listaPda) return;
    try {
      const datos: any = await program.account.listaTareas.fetchNullable(listaPda);
      if (!datos) {
        setLista(null);
        setTareas([]);
        return;
      }
      setLista({ nombre: datos.nombre, activas: datos.activas });

      // Filtra las tareas cuya primera cuenta (lista) sea esta lista (offset 8 = después del discriminador)
      const cuentas: any[] = await program.account.tarea.all([
        { memcmp: { offset: 8, bytes: listaPda.toBase58() } },
      ]);
      const ordenadas = cuentas
        .map((c) => ({
          pubkey: c.publicKey as PublicKey,
          id: c.account.id as number,
          titulo: c.account.titulo as string,
          completada: c.account.completada as boolean,
        }))
        .sort((a, b) => a.id - b.id);
      setTareas(ordenadas);
    } catch (e: any) {
      setMensaje({ tipo: "error", texto: e?.message ?? "No se pudo leer la información" });
    }
  }, [program, listaPda]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  // Ejecuta una operación: firma, confirma, muestra la firma y vuelve a leer los datos
  const ejecutar = async (nombre: string, accion: () => Promise<string>) => {
    setCargando(true);
    setMensaje(null);
    try {
      const sig = await accion(); // .rpc() firma con la wallet y espera la confirmación
      setMensaje({
        tipo: "ok",
        texto: `${nombre} listo ✅ Firma: ${sig} — https://explorer.solana.com/tx/${sig}?cluster=devnet`,
      });
      await cargar();
    } catch (e: any) {
      // Los errores del programa vienen con mensaje en español (#[msg(...)])
      const texto =
        e?.error?.errorMessage ?? e?.message ?? "Ocurrió un error inesperado";
      setMensaje({ tipo: "error", texto: `${nombre} falló: ${texto}` });
    } finally {
      setCargando(false);
    }
  };

  const crearLista = () =>
    ejecutar("Crear lista", () =>
      program!.methods
        .crearLista(nombreLista.trim())
        .accounts({
          lista: listaPda!,
          owner: wallet!.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    ).then(() => setNombreLista(""));

  const crearTarea = async () => {
    // El id de la nueva tarea es el contador total_creadas de la lista
    const datos: any = await program!.account.listaTareas.fetch(listaPda!);
    const nuevoId = datos.totalCreadas as number;
    await ejecutar("Crear tarea", () =>
      program!.methods
        .crearTarea(titulo.trim())
        .accounts({
          lista: listaPda!,
          tarea: tareaPda(nuevoId),
          owner: wallet!.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
    setTitulo("");
  };

  const completar = (t: Tarea) =>
    ejecutar("Completar tarea", () =>
      program!.methods
        .completarTarea()
        .accounts({ lista: listaPda!, tarea: t.pubkey, owner: wallet!.publicKey })
        .rpc()
    );

  const cerrar = (t: Tarea) =>
    ejecutar("Cerrar tarea", () =>
      program!.methods
        .cerrarTarea()
        .accounts({ lista: listaPda!, tarea: t.pubkey, owner: wallet!.publicKey })
        .rpc()
    );

  const editar = (t: Tarea) => {
    const nuevo = window.prompt("Nuevo título:", t.titulo);
    if (!nuevo) return;
    ejecutar("Actualizar título", () =>
      program!.methods
        .actualizarTitulo(nuevo.trim())
        .accounts({ lista: listaPda!, tarea: t.pubkey, owner: wallet!.publicKey })
        .rpc()
    );
  };

  return (
    <div className="contenedor">
      <header>
        <h1>📝 Tareas en Solana</h1>
        <WalletMultiButton />
      </header>
      <p className="pequeno">
        Red: Devnet · Programa: {program ? program.programId.toBase58() : "conecta tu wallet"}
      </p>

      {!wallet && (
        <div className="tarjeta">Conecta tu wallet (Phantom en Devnet) para empezar.</div>
      )}

      {wallet && !lista && (
        <div className="tarjeta">
          <strong>Crea tu lista</strong>
          <div className="fila">
            <input
              type="text"
              placeholder="Nombre de la lista (máx. 32)"
              value={nombreLista}
              onChange={(e) => setNombreLista(e.target.value)}
            />
            <button
              className="accion"
              disabled={cargando || !nombreLista.trim()}
              onClick={crearLista}
            >
              Crear
            </button>
          </div>
        </div>
      )}

      {wallet && lista && (
        <>
          <div className="tarjeta">
            <strong>{lista.nombre}</strong>{" "}
            <span className="pequeno">· {lista.activas} tareas activas</span>
            <div className="fila">
              <input
                type="text"
                placeholder="Nueva tarea (máx. 64)"
                value={titulo}
                onChange={(e) => setTitulo(e.target.value)}
              />
              <button
                className="accion"
                disabled={cargando || !titulo.trim()}
                onClick={crearTarea}
              >
                Agregar
              </button>
            </div>
          </div>

          <div className="tarjeta">
            {tareas.length === 0 && <span className="pequeno">Aún no hay tareas.</span>}
            {tareas.map((t) => (
              <div key={t.pubkey.toBase58()} className={`tarea ${t.completada ? "hecha" : ""}`}>
                <span className="titulo">{t.titulo}</span>
                <div className="acciones">
                  {!t.completada && (
                    <>
                      <button
                        className="accion secundario"
                        disabled={cargando}
                        onClick={() => editar(t)}
                      >
                        Editar
                      </button>
                      <button
                        className="accion"
                        disabled={cargando}
                        onClick={() => completar(t)}
                      >
                        Completar
                      </button>
                    </>
                  )}
                  {/* Se deja el botón siempre visible a propósito: si la tarea no está
                      completada, el PROGRAMA rechaza el cierre y se muestra el error. */}
                  <button
                    className="accion peligro"
                    disabled={cargando}
                    onClick={() => cerrar(t)}
                  >
                    Cerrar
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {mensaje && <div className={`aviso ${mensaje.tipo}`}>{mensaje.texto}</div>}
    </div>
  );
}
