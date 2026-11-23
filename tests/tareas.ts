import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { expect } from "chai";

describe("tareas", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // El IDL se genera con `anchor build`
  const program = anchor.workspace.Tareas as Program<any>;
  const owner = provider.wallet.publicKey;

  // Las pruebas se pueden repetir en Devnet: el id de la tarea se calcula en la prueba 2
  let idTarea = 0;
  let activasTrasCrear = 0;

  const [listaPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lista"), owner.toBuffer()],
    program.programId
  );

  const tareaPda = (lista: PublicKey, id: number) => {
    const idBuf = Buffer.alloc(4);
    idBuf.writeUInt32LE(id);
    return PublicKey.findProgramAddressSync(
      [Buffer.from("tarea"), lista.toBuffer(), idBuf],
      program.programId
    )[0];
  };

  // Ayuda para comprobar que una promesa falla con cierto error
  const debeFallar = async (promesa: Promise<any>, texto: string) => {
    try {
      await promesa;
    } catch (e: any) {
      const msg = (e?.error?.errorMessage ?? e?.message ?? "").toString();
      const logs = (e?.logs ?? []).join(" ");
      expect(msg + " " + logs).to.include(texto);
      return;
    }
    throw new Error("Se esperaba un error y la transacción pasó");
  };

  it("1. CREAR: crea la lista", async () => {
    const existente = await program.account.listaTareas.fetchNullable(listaPda);
    if (!existente) {
      const sig = await program.methods
        .crearLista("Mis tareas")
        .accounts({ lista: listaPda, owner, systemProgram: SystemProgram.programId })
        .rpc();
      console.log("   tx crear_lista:", sig);
    } else {
      console.log("   (la lista ya existía de una corrida anterior, se reutiliza)");
    }

    const lista = await program.account.listaTareas.fetch(listaPda);
    expect(lista.owner.toBase58()).to.equal(owner.toBase58());
    expect(lista.nombre).to.be.a("string");
  });

  it("2. CREAR: crea una tarea ligada a la lista", async () => {
    const antes = await program.account.listaTareas.fetch(listaPda);
    idTarea = antes.totalCreadas;
    const tarea0 = tareaPda(listaPda, idTarea);
    const sig = await program.methods
      .crearTarea("Entregar proyecto de Solana")
      .accounts({ lista: listaPda, tarea: tarea0, owner, systemProgram: SystemProgram.programId })
      .rpc();
    console.log("   tx crear_tarea:", sig);

    // LEER
    const tarea = await program.account.tarea.fetch(tarea0);
    expect(tarea.titulo).to.equal("Entregar proyecto de Solana");
    expect(tarea.completada).to.equal(false);
    expect(tarea.lista.toBase58()).to.equal(listaPda.toBase58());

    const lista = await program.account.listaTareas.fetch(listaPda);
    expect(tarea.id).to.equal(idTarea);
    expect(lista.totalCreadas).to.equal(idTarea + 1);
    expect(lista.activas).to.equal(antes.activas + 1);
    activasTrasCrear = lista.activas;
  });

  it("3. MODIFICAR: actualiza el título", async () => {
    const tarea0 = tareaPda(listaPda, idTarea);
    await program.methods
      .actualizarTitulo("Entregar proyecto final de Solana")
      .accounts({ lista: listaPda, tarea: tarea0, owner })
      .rpc();

    const tarea = await program.account.tarea.fetch(tarea0);
    expect(tarea.titulo).to.equal("Entregar proyecto final de Solana");
  });

  it("4. REGLA DE CIERRE (rechazo): no deja cerrar una tarea sin completar", async () => {
    const tarea0 = tareaPda(listaPda, idTarea);
    await debeFallar(
      program.methods
        .cerrarTarea()
        .accounts({ lista: listaPda, tarea: tarea0, owner })
        .rpc(),
      "TareaNoCompletada"
    );

    // Sigue existiendo
    const tarea = await program.account.tarea.fetch(tarea0);
    expect(tarea.completada).to.equal(false);
  });

  it("5. PERMISOS (rechazo): otro usuario no puede completar mi tarea", async () => {
    const intruso = Keypair.generate();
    // Se le pasa un poquito de SOL desde tu wallet (en Devnet el airdrop suele fallar por límites)
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: owner,
          toPubkey: intruso.publicKey,
          lamports: 0.01 * LAMPORTS_PER_SOL,
        })
      )
    );

    const tarea0 = tareaPda(listaPda, idTarea);

    // El intruso firma e intenta modificar MI tarea usando MI lista
    let fallo = false;
    try {
      await program.methods
        .completarTarea()
        .accounts({ lista: listaPda, tarea: tarea0, owner: intruso.publicKey })
        .signers([intruso])
        .rpc();
    } catch (e: any) {
      fallo = true;
      console.log("   rechazado por el programa:", e?.error?.errorMessage ?? e?.message);
    }
    expect(fallo).to.equal(true);

    const tarea = await program.account.tarea.fetch(tarea0);
    expect(tarea.completada).to.equal(false);
  });

  it("6. MODIFICAR: completa la tarea", async () => {
    const tarea0 = tareaPda(listaPda, idTarea);
    const sig = await program.methods
      .completarTarea()
      .accounts({ lista: listaPda, tarea: tarea0, owner })
      .rpc();
    console.log("   tx completar_tarea:", sig);

    const tarea = await program.account.tarea.fetch(tarea0);
    expect(tarea.completada).to.equal(true);
  });

  it("7. REGLA (rechazo): no deja completar dos veces", async () => {
    const tarea0 = tareaPda(listaPda, idTarea);
    await debeFallar(
      program.methods
        .completarTarea()
        .accounts({ lista: listaPda, tarea: tarea0, owner })
        .rpc(),
      "YaCompletada"
    );
  });

  it("8. CERRAR: cierra la tarea completada y devuelve la renta", async () => {
    const tarea0 = tareaPda(listaPda, idTarea);
    const sig = await program.methods
      .cerrarTarea()
      .accounts({ lista: listaPda, tarea: tarea0, owner })
      .rpc();
    console.log("   tx cerrar_tarea:", sig);

    const info = await provider.connection.getAccountInfo(tarea0);
    expect(info).to.equal(null); // la cuenta ya no existe

    const lista = await program.account.listaTareas.fetch(listaPda);
    expect(lista.activas).to.equal(activasTrasCrear - 1);
  });
});
