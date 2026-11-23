use anchor_lang::prelude::*;

// Este ID es temporal. Al correr `anchor keys sync` se reemplaza por el tuyo.
declare_id!("11111111111111111111111111111111");

#[program]
pub mod tareas {
    use super::*;

    /// Crea la lista de tareas del usuario (cuenta PDA: ["lista", owner]).
    pub fn crear_lista(ctx: Context<CrearLista>, nombre: String) -> Result<()> {
        require!(
            nombre.len() <= ListaTareas::MAX_NOMBRE,
            ErrorTareas::NombreMuyLargo
        );

        let lista = &mut ctx.accounts.lista;
        lista.owner = ctx.accounts.owner.key();
        lista.nombre = nombre;
        lista.total_creadas = 0;
        lista.activas = 0;
        lista.bump = ctx.bumps.lista;
        Ok(())
    }

    /// Crea una tarea ligada a la lista (cuenta PDA: ["tarea", lista, id]).
    pub fn crear_tarea(ctx: Context<CrearTarea>, titulo: String) -> Result<()> {
        require!(
            !titulo.trim().is_empty(),
            ErrorTareas::TituloVacio
        );
        require!(
            titulo.len() <= Tarea::MAX_TITULO,
            ErrorTareas::TituloMuyLargo
        );

        let lista = &mut ctx.accounts.lista;
        let tarea = &mut ctx.accounts.tarea;

        tarea.lista = lista.key();
        tarea.owner = ctx.accounts.owner.key();
        tarea.id = lista.total_creadas;
        tarea.titulo = titulo;
        tarea.completada = false;
        tarea.bump = ctx.bumps.tarea;

        lista.total_creadas = lista
            .total_creadas
            .checked_add(1)
            .ok_or(ErrorTareas::Desbordamiento)?;
        lista.activas = lista
            .activas
            .checked_add(1)
            .ok_or(ErrorTareas::Desbordamiento)?;
        Ok(())
    }

    /// Modifica el título de una tarea que todavía no está completada.
    pub fn actualizar_titulo(ctx: Context<ModificarTarea>, nuevo_titulo: String) -> Result<()> {
        require!(
            !nuevo_titulo.trim().is_empty(),
            ErrorTareas::TituloVacio
        );
        require!(
            nuevo_titulo.len() <= Tarea::MAX_TITULO,
            ErrorTareas::TituloMuyLargo
        );
        let tarea = &mut ctx.accounts.tarea;
        require!(!tarea.completada, ErrorTareas::YaCompletada);
        tarea.titulo = nuevo_titulo;
        Ok(())
    }

    /// Marca la tarea como completada (solo una vez).
    pub fn completar_tarea(ctx: Context<ModificarTarea>) -> Result<()> {
        let tarea = &mut ctx.accounts.tarea;
        require!(!tarea.completada, ErrorTareas::YaCompletada);
        tarea.completada = true;
        Ok(())
    }

    /// Cierra la tarea y devuelve la renta al dueño.
    /// REGLA: solo se puede cerrar si ya está completada.
    pub fn cerrar_tarea(ctx: Context<CerrarTarea>) -> Result<()> {
        let lista = &mut ctx.accounts.lista;
        lista.activas = lista
            .activas
            .checked_sub(1)
            .ok_or(ErrorTareas::Desbordamiento)?;
        Ok(())
    }
}

// ---------------------------------------------------------------------
// Cuentas
// ---------------------------------------------------------------------

#[account]
pub struct ListaTareas {
    pub owner: Pubkey,      // 32
    pub nombre: String,     // 4 + MAX_NOMBRE
    pub total_creadas: u32, // 4 (sirve para generar el id de cada tarea)
    pub activas: u32,       // 4
    pub bump: u8,           // 1
}

impl ListaTareas {
    pub const MAX_NOMBRE: usize = 32;
    pub const SPACE: usize = 8 + 32 + (4 + Self::MAX_NOMBRE) + 4 + 4 + 1;
}

#[account]
pub struct Tarea {
    pub lista: Pubkey,     // 32
    pub owner: Pubkey,     // 32
    pub id: u32,           // 4
    pub titulo: String,    // 4 + MAX_TITULO
    pub completada: bool,  // 1
    pub bump: u8,          // 1
}

impl Tarea {
    pub const MAX_TITULO: usize = 64;
    pub const SPACE: usize = 8 + 32 + 32 + 4 + (4 + Self::MAX_TITULO) + 1 + 1;
}

// ---------------------------------------------------------------------
// Contextos (validaciones de autoridad, pertenencia y cierre)
// ---------------------------------------------------------------------

#[derive(Accounts)]
pub struct CrearLista<'info> {
    #[account(
        init,
        payer = owner,
        space = ListaTareas::SPACE,
        seeds = [b"lista", owner.key().as_ref()],
        bump
    )]
    pub lista: Account<'info, ListaTareas>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CrearTarea<'info> {
    // AUTORIDAD: la lista debe ser del que firma.
    #[account(
        mut,
        seeds = [b"lista", owner.key().as_ref()],
        bump = lista.bump,
        has_one = owner @ ErrorTareas::NoAutorizado
    )]
    pub lista: Account<'info, ListaTareas>,

    #[account(
        init,
        payer = owner,
        space = Tarea::SPACE,
        seeds = [b"tarea", lista.key().as_ref(), &lista.total_creadas.to_le_bytes()],
        bump
    )]
    pub tarea: Account<'info, Tarea>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ModificarTarea<'info> {
    #[account(
        seeds = [b"lista", owner.key().as_ref()],
        bump = lista.bump,
        has_one = owner @ ErrorTareas::NoAutorizado
    )]
    pub lista: Account<'info, ListaTareas>,

    // AUTORIDAD (has_one = owner) y PERTENENCIA (has_one = lista).
    #[account(
        mut,
        has_one = owner @ ErrorTareas::NoAutorizado,
        has_one = lista @ ErrorTareas::NoPertenece
    )]
    pub tarea: Account<'info, Tarea>,

    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct CerrarTarea<'info> {
    #[account(
        mut,
        seeds = [b"lista", owner.key().as_ref()],
        bump = lista.bump,
        has_one = owner @ ErrorTareas::NoAutorizado
    )]
    pub lista: Account<'info, ListaTareas>,

    // CIERRE CONDICIONADO: solo si la tarea está completada.
    // `close = owner` devuelve los lamports (la renta) al dueño.
    #[account(
        mut,
        close = owner,
        has_one = owner @ ErrorTareas::NoAutorizado,
        has_one = lista @ ErrorTareas::NoPertenece,
        constraint = tarea.completada @ ErrorTareas::TareaNoCompletada
    )]
    pub tarea: Account<'info, Tarea>,

    #[account(mut)]
    pub owner: Signer<'info>,
}

// ---------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------

#[error_code]
pub enum ErrorTareas {
    #[msg("El nombre de la lista es demasiado largo (máx. 32 bytes)")]
    NombreMuyLargo,
    #[msg("El título es demasiado largo (máx. 64 bytes)")]
    TituloMuyLargo,
    #[msg("El título no puede estar vacío")]
    TituloVacio,
    #[msg("No eres el dueño de esta lista o tarea")]
    NoAutorizado,
    #[msg("La tarea no pertenece a esta lista")]
    NoPertenece,
    #[msg("La tarea ya está completada")]
    YaCompletada,
    #[msg("Solo se puede cerrar una tarea que ya está completada")]
    TareaNoCompletada,
    #[msg("Error de desbordamiento numérico")]
    Desbordamiento,
}
