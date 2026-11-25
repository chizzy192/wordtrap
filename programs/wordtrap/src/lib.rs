//! WordTrap — commit-reveal word mines + backer pool, settled in USDC.
//!
//! Roles
//! - `authority`  : the game referee (WordTrap server). Opens matches, records every word
//!                  Byte says aloud, advances turns, ends the match.
//! - trap setter  : locks USDC behind sha256("wordtrap:v1" | word | salt | setter).
//!                  If Byte later SAYS that word, the setter reveals and claims stake + bounty.
//! - backer       : bets on Byte. Funds the bounty budget; after the reveal window, backers
//!                  sweep everything left in the vault (their deposits minus bounties paid,
//!                  plus every trap that never fired).
//!
//! Turn bitmap: each spoken word stores a 128-bit bitmap of the turns it was said in, plus the
//! first turn Byte CHALLENGED it (named it as a suspected mine without saying it). A trap fires
//! iff the word was spoken on some turn t >= armed_turn and, if a challenge landed while the
//! trap was armed, t < challenged_turn. Traps arm on the turn AFTER they are planted, so a
//! setter can never mine a word that is already being said.

use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

pub const MAX_TURNS: u16 = 128;
pub const MAX_WORD_LEN: usize = 32;
pub const NO_CHALLENGE: u16 = u16::MAX;
pub const COMMIT_DOMAIN: &[u8] = b"wordtrap:v1";
pub const WORD_DOMAIN: &[u8] = b"wordtrap:word";

#[program]
pub mod wordtrap {
    use super::*;

    pub fn initialize_match(
        ctx: Context<InitializeMatch>,
        match_id: u64,
        bounty_multiplier_bps: u16,
        reveal_window_secs: i64,
        min_stake: u64,
    ) -> Result<()> {
        require!(bounty_multiplier_bps >= 10_000 && bounty_multiplier_bps <= 50_000, WtError::BadParam);
        require!(reveal_window_secs > 0 && reveal_window_secs <= 7 * 86_400, WtError::BadParam);
        let m = &mut ctx.accounts.game;
        m.authority = ctx.accounts.authority.key();
        m.mint = ctx.accounts.mint.key();
        m.vault = ctx.accounts.vault.key();
        m.match_id = match_id;
        m.status = Status::Open;
        m.turn = 0;
        m.bounty_multiplier_bps = bounty_multiplier_bps;
        m.reveal_window_secs = reveal_window_secs;
        m.min_stake = min_stake;
        m.backer_total = 0;
        m.bounty_budget = 0;
        m.trap_total = 0;
        m.traps_fired = 0;
        m.reveal_deadline = 0;
        m.final_pool = 0;
        m.byte_survived = false;
        m.bump = ctx.bumps.game;
        m.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    pub fn start_match(ctx: Context<AuthorityOnly>) -> Result<()> {
        let m = &mut ctx.accounts.game;
        require!(m.status == Status::Open, WtError::WrongStatus);
        m.status = Status::Live;
        m.turn = 1;
        emit!(TurnAdvanced { game: m.key(), turn: 1 });
        Ok(())
    }

    pub fn back_byte(ctx: Context<BackByte>, amount: u64) -> Result<()> {
        require!(matches!(ctx.accounts.game.status, Status::Open | Status::Live), WtError::WrongStatus);
        require!(amount > 0, WtError::BadParam);
        token::transfer(ctx.accounts.deposit_ctx(), amount)?;
        let m = &mut ctx.accounts.game;
        let b = &mut ctx.accounts.backer;
        if b.owner == Pubkey::default() {
            b.owner = ctx.accounts.user.key();
            b.game = m.key();
            b.bump = ctx.bumps.backer;
        }
        b.amount = b.amount.checked_add(amount).ok_or(WtError::Overflow)?;
        m.backer_total = m.backer_total.checked_add(amount).ok_or(WtError::Overflow)?;
        m.bounty_budget = m.bounty_budget.checked_add(amount).ok_or(WtError::Overflow)?;
        emit!(Backed { game: m.key(), backer: b.owner, amount });
        Ok(())
    }

    /// `revealer`: a hot key on the setter's phone allowed to fire the reveal without a wallet
    /// popup. Payout still goes only to the setter's token account.
    pub fn plant_trap(ctx: Context<PlantTrap>, commitment: [u8; 32], stake: u64, revealer: Pubkey) -> Result<()> {
        {
            let m = &ctx.accounts.game;
            require!(matches!(m.status, Status::Open | Status::Live), WtError::WrongStatus);
            require!(stake >= m.min_stake && stake > 0, WtError::StakeTooSmall);
            require!(m.turn < MAX_TURNS - 1, WtError::TooManyTurns);
        }
        token::transfer(ctx.accounts.deposit_ctx(), stake)?;
        let m = &mut ctx.accounts.game;
        let t = &mut ctx.accounts.trap;
        t.game = m.key();
        t.setter = ctx.accounts.setter.key();
        t.revealer = revealer;
        t.commitment = commitment;
        t.stake = stake;
        // Armed from the next turn: the current turn's words may already be in flight.
        t.armed_turn = m.turn.checked_add(1).ok_or(WtError::Overflow)?;
        t.status = TrapStatus::Armed;
        t.bump = ctx.bumps.trap;
        m.trap_total = m.trap_total.checked_add(stake).ok_or(WtError::Overflow)?;
        emit!(TrapPlanted { game: m.key(), trap: t.key(), stake, armed_turn: t.armed_turn });
        Ok(())
    }

    /// Referee logs a word Byte said aloud (kind = Spoken) or named as a suspected mine
    /// (kind = Challenged). `word` must already be normalized: lowercase a-z, 1..=32 chars.
    pub fn record_word(ctx: Context<RecordWord>, word: String, kind: WordKind) -> Result<()> {
        let m = &ctx.accounts.game;
        require!(m.status == Status::Live, WtError::WrongStatus);
        validate_word(&word)?;
        let w = &mut ctx.accounts.word_log;
        if w.game == Pubkey::default() {
            w.game = m.key();
            w.word_hash = word_hash(&word);
            w.spoken_bitmap = 0;
            w.challenged_turn = NO_CHALLENGE;
            w.bump = ctx.bumps.word_log;
        }
        match kind {
            WordKind::Spoken => w.spoken_bitmap |= 1u128 << m.turn,
            WordKind::Challenged => {
                if w.challenged_turn == NO_CHALLENGE {
                    w.challenged_turn = m.turn;
                }
            }
        }
        emit!(WordRecorded { game: m.key(), word, kind, turn: m.turn });
        Ok(())
    }

    pub fn advance_turn(ctx: Context<AuthorityOnly>) -> Result<()> {
        let m = &mut ctx.accounts.game;
        require!(m.status == Status::Live, WtError::WrongStatus);
        require!(m.turn + 1 < MAX_TURNS, WtError::TooManyTurns);
        m.turn += 1;
        emit!(TurnAdvanced { game: m.key(), turn: m.turn });
        Ok(())
    }

    pub fn end_match(ctx: Context<AuthorityOnly>, byte_survived: bool) -> Result<()> {
        let m = &mut ctx.accounts.game;
        require!(m.status == Status::Live, WtError::WrongStatus);
        m.status = Status::Ended;
        m.byte_survived = byte_survived;
        m.reveal_deadline = Clock::get()?
            .unix_timestamp
            .checked_add(m.reveal_window_secs)
            .ok_or(WtError::Overflow)?;
        emit!(MatchEnded { game: m.key(), byte_survived, reveal_deadline: m.reveal_deadline });
        Ok(())
    }

    /// Setter proves their mined word was spoken while armed. Allowed live (instant on-stream
    /// detonation) or after the match until the reveal deadline.
    pub fn reveal_trap(ctx: Context<RevealTrap>, word: String, salt: [u8; 32]) -> Result<()> {
        let game_key = ctx.accounts.game.key();
        let m = &mut ctx.accounts.game;
        let t = &mut ctx.accounts.trap;
        let w = &ctx.accounts.word_log;
        match m.status {
            Status::Live => {}
            Status::Ended => require!(Clock::get()?.unix_timestamp <= m.reveal_deadline, WtError::RevealClosed),
            _ => return err!(WtError::WrongStatus),
        }
        require!(t.status == TrapStatus::Armed, WtError::TrapNotArmed);
        validate_word(&word)?;
        require!(commitment(&word, &salt, &t.setter) == t.commitment, WtError::BadReveal);
        require!(w.word_hash == word_hash(&word), WtError::BadReveal);
        require!(
            trap_fired(w.spoken_bitmap, w.challenged_turn, t.armed_turn),
            WtError::NotTriggered
        );

        let bounty = bounty_for(t.stake, m.bounty_multiplier_bps, m.bounty_budget);
        m.bounty_budget -= bounty;
        m.traps_fired += 1;
        t.status = TrapStatus::Fired;
        let payout = t.stake.checked_add(bounty).ok_or(WtError::Overflow)?;

        let id = m.match_id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"match", m.authority.as_ref(), &id, &[m.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.setter_ata.to_account_info(),
                    authority: m.to_account_info(),
                },
                &[seeds],
            ),
            payout,
        )?;
        emit!(TrapFired { game: game_key, trap: t.key(), word, payout, turn: m.turn });
        Ok(())
    }

    /// After the reveal window, snapshot what is left in the vault for backers.
    pub fn finalize(ctx: Context<Finalize>) -> Result<()> {
        let m = &mut ctx.accounts.game;
        require!(m.status == Status::Ended, WtError::WrongStatus);
        require!(Clock::get()?.unix_timestamp > m.reveal_deadline, WtError::RevealStillOpen);
        m.status = Status::Finalized;
        m.final_pool = ctx.accounts.vault.amount;
        emit!(Finalized { game: m.key(), final_pool: m.final_pool });
        Ok(())
    }

    pub fn claim_backer(ctx: Context<ClaimBacker>) -> Result<()> {
        let m = &ctx.accounts.game;
        require!(m.status == Status::Finalized, WtError::WrongStatus);
        let b = &mut ctx.accounts.backer;
        require!(!b.claimed, WtError::AlreadyClaimed);
        let share = pro_rata(m.final_pool, b.amount, m.backer_total);
        b.claimed = true;
        let id = m.match_id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"match", m.authority.as_ref(), &id, &[m.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user_ata.to_account_info(),
                    authority: ctx.accounts.game.to_account_info(),
                },
                &[seeds],
            ),
            share,
        )?;
        Ok(())
    }

    /// Edge case: nobody backed Byte, so unfired trap stakes have no one to sweep them.
    pub fn refund_trap(ctx: Context<RefundTrap>) -> Result<()> {
        let m = &ctx.accounts.game;
        require!(m.status == Status::Finalized && m.backer_total == 0, WtError::WrongStatus);
        let t = &mut ctx.accounts.trap;
        require!(t.status == TrapStatus::Armed, WtError::TrapNotArmed);
        t.status = TrapStatus::Refunded;
        let id = m.match_id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"match", m.authority.as_ref(), &id, &[m.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.setter_ata.to_account_info(),
                    authority: ctx.accounts.game.to_account_info(),
                },
                &[seeds],
            ),
            t.stake,
        )?;
        Ok(())
    }
}

// ---------- pure logic (unit-tested below, mirrored in packages/shared) ----------

pub fn validate_word(word: &str) -> Result<()> {
    require!(
        !word.is_empty() && word.len() <= MAX_WORD_LEN && word.bytes().all(|c| c.is_ascii_lowercase()),
        WtError::BadWord
    );
    Ok(())
}

pub fn word_hash(word: &str) -> [u8; 32] {
    hashv(&[WORD_DOMAIN, word.as_bytes()]).to_bytes()
}

pub fn commitment(word: &str, salt: &[u8; 32], setter: &Pubkey) -> [u8; 32] {
    hashv(&[COMMIT_DOMAIN, word.as_bytes(), salt, setter.as_ref()]).to_bytes()
}

/// Fired iff spoken on some turn t >= armed and (no challenge while armed, or t < challenge).
pub fn trap_fired(spoken_bitmap: u128, challenged_turn: u16, armed_turn: u16) -> bool {
    if armed_turn >= 128 {
        return false;
    }
    let from_armed = spoken_bitmap & (u128::MAX << armed_turn);
    if challenged_turn == NO_CHALLENGE || challenged_turn < armed_turn {
        return from_armed != 0;
    }
    if challenged_turn >= 128 {
        return from_armed != 0;
    }
    // keep only turns strictly before the challenge
    let before_challenge = if challenged_turn == 0 { 0 } else { u128::MAX >> (128 - challenged_turn) };
    from_armed & before_challenge != 0
}

pub fn bounty_for(stake: u64, multiplier_bps: u16, budget: u64) -> u64 {
    let extra = (stake as u128) * (multiplier_bps as u128 - 10_000) / 10_000;
    (extra.min(budget as u128)) as u64
}

pub fn pro_rata(pool: u64, amount: u64, total: u64) -> u64 {
    if total == 0 {
        return 0;
    }
    ((pool as u128) * (amount as u128) / (total as u128)) as u64
}

// ---------- accounts ----------

#[account]
#[derive(InitSpace)]
pub struct Game {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub match_id: u64,
    pub status: Status,
    pub turn: u16,
    pub bounty_multiplier_bps: u16,
    pub reveal_window_secs: i64,
    pub min_stake: u64,
    pub backer_total: u64,
    pub bounty_budget: u64,
    pub trap_total: u64,
    pub traps_fired: u32,
    pub reveal_deadline: i64,
    pub final_pool: u64,
    pub byte_survived: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Backer {
    pub game: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub claimed: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Trap {
    pub game: Pubkey,
    pub setter: Pubkey,
    pub revealer: Pubkey,
    pub commitment: [u8; 32],
    pub stake: u64,
    pub armed_turn: u16,
    pub status: TrapStatus,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct WordLog {
    pub game: Pubkey,
    pub word_hash: [u8; 32],
    pub spoken_bitmap: u128,
    pub challenged_turn: u16,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum Status { Open, Live, Ended, Finalized }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum TrapStatus { Armed, Fired, Refunded }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum WordKind { Spoken, Challenged }

// ---------- contexts ----------

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct InitializeMatch<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init, payer = authority, space = 8 + Game::INIT_SPACE,
        seeds = [b"match", authority.key().as_ref(), &match_id.to_le_bytes()], bump
    )]
    pub game: Account<'info, Game>,
    pub mint: Account<'info, Mint>,
    #[account(
        init, payer = authority, seeds = [b"vault", game.key().as_ref()], bump,
        token::mint = mint, token::authority = game
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AuthorityOnly<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority)]
    pub game: Account<'info, Game>,
}

#[derive(Accounts)]
pub struct BackByte<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, has_one = vault)]
    pub game: Account<'info, Game>,
    #[account(
        init_if_needed, payer = user, space = 8 + Backer::INIT_SPACE,
        seeds = [b"backer", game.key().as_ref(), user.key().as_ref()], bump
    )]
    pub backer: Account<'info, Backer>,
    #[account(mut, token::mint = game.mint, token::authority = user)]
    pub user_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

impl<'info> BackByte<'info> {
    fn deposit_ctx(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        CpiContext::new(
            self.token_program.to_account_info(),
            Transfer {
                from: self.user_ata.to_account_info(),
                to: self.vault.to_account_info(),
                authority: self.user.to_account_info(),
            },
        )
    }
}

#[derive(Accounts)]
#[instruction(commitment: [u8; 32])]
pub struct PlantTrap<'info> {
    #[account(mut)]
    pub setter: Signer<'info>,
    #[account(mut, has_one = vault)]
    pub game: Account<'info, Game>,
    #[account(
        init, payer = setter, space = 8 + Trap::INIT_SPACE,
        seeds = [b"trap", game.key().as_ref(), &commitment], bump
    )]
    pub trap: Account<'info, Trap>,
    #[account(mut, token::mint = game.mint, token::authority = setter)]
    pub setter_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

impl<'info> PlantTrap<'info> {
    fn deposit_ctx(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        CpiContext::new(
            self.token_program.to_account_info(),
            Transfer {
                from: self.setter_ata.to_account_info(),
                to: self.vault.to_account_info(),
                authority: self.setter.to_account_info(),
            },
        )
    }
}

#[derive(Accounts)]
#[instruction(word: String)]
pub struct RecordWord<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(has_one = authority)]
    pub game: Account<'info, Game>,
    #[account(
        init_if_needed, payer = authority, space = 8 + WordLog::INIT_SPACE,
        seeds = [b"word", game.key().as_ref(), &word_hash(&word)], bump
    )]
    pub word_log: Account<'info, WordLog>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(word: String)]
pub struct RevealTrap<'info> {
    /// setter or their registered revealer key
    pub caller: Signer<'info>,
    #[account(mut, has_one = vault)]
    pub game: Account<'info, Game>,
    #[account(
        mut, has_one = game,
        constraint = caller.key() == trap.setter || caller.key() == trap.revealer @ WtError::Unauthorized
    )]
    pub trap: Account<'info, Trap>,
    #[account(seeds = [b"word", game.key().as_ref(), &word_hash(&word)], bump = word_log.bump)]
    pub word_log: Account<'info, WordLog>,
    #[account(mut, token::mint = game.mint, token::authority = trap.setter)]
    pub setter_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Finalize<'info> {
    #[account(mut, has_one = vault)]
    pub game: Account<'info, Game>,
    pub vault: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct ClaimBacker<'info> {
    pub user: Signer<'info>,
    #[account(has_one = vault)]
    pub game: Account<'info, Game>,
    #[account(
        mut, has_one = game,
        constraint = backer.owner == user.key() @ WtError::Unauthorized
    )]
    pub backer: Account<'info, Backer>,
    #[account(mut, token::mint = game.mint, token::authority = user)]
    pub user_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RefundTrap<'info> {
    pub setter: Signer<'info>,
    #[account(has_one = vault)]
    pub game: Account<'info, Game>,
    #[account(mut, has_one = game, has_one = setter)]
    pub trap: Account<'info, Trap>,
    #[account(mut, token::mint = game.mint, token::authority = setter)]
    pub setter_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

// ---------- events & errors ----------

#[event] pub struct Backed { pub game: Pubkey, pub backer: Pubkey, pub amount: u64 }
#[event] pub struct TrapPlanted { pub game: Pubkey, pub trap: Pubkey, pub stake: u64, pub armed_turn: u16 }
#[event] pub struct WordRecorded { pub game: Pubkey, pub word: String, pub kind: WordKind, pub turn: u16 }
#[event] pub struct TurnAdvanced { pub game: Pubkey, pub turn: u16 }
#[event] pub struct MatchEnded { pub game: Pubkey, pub byte_survived: bool, pub reveal_deadline: i64 }
#[event] pub struct TrapFired { pub game: Pubkey, pub trap: Pubkey, pub word: String, pub payout: u64, pub turn: u16 }
#[event] pub struct Finalized { pub game: Pubkey, pub final_pool: u64 }

#[error_code]
pub enum WtError {
    #[msg("Invalid parameter")] BadParam,
    #[msg("Match is not in the right status")] WrongStatus,
    #[msg("Stake below match minimum")] StakeTooSmall,
    #[msg("Turn limit reached")] TooManyTurns,
    #[msg("Word must be 1-32 lowercase a-z characters")] BadWord,
    #[msg("Reveal does not match commitment")] BadReveal,
    #[msg("Word was not spoken while the trap was armed")] NotTriggered,
    #[msg("Trap is not armed")] TrapNotArmed,
    #[msg("Reveal window closed")] RevealClosed,
    #[msg("Reveal window still open")] RevealStillOpen,
    #[msg("Already claimed")] AlreadyClaimed,
    #[msg("Unauthorized")] Unauthorized,
    #[msg("Arithmetic overflow")] Overflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bm(turns: &[u16]) -> u128 { turns.iter().fold(0, |a, t| a | (1u128 << t)) }

    #[test]
    fn fires_only_after_armed() {
        assert!(!trap_fired(bm(&[1, 2]), NO_CHALLENGE, 3));
        assert!(trap_fired(bm(&[1, 3]), NO_CHALLENGE, 3));
        assert!(trap_fired(bm(&[127]), NO_CHALLENGE, 5));
    }

    #[test]
    fn challenge_defuses_later_speech() {
        // armed at 3, Byte challenges at 4, says it at 6 -> defused
        assert!(!trap_fired(bm(&[6]), 4, 3));
        // said at 3 before challenge at 4 -> already fired
        assert!(trap_fired(bm(&[3, 6]), 4, 3));
        // challenge BEFORE arming doesn't protect
        assert!(trap_fired(bm(&[6]), 2, 3));
        // challenge on the same turn as speech: challenge wins (t < challenged required)
        assert!(!trap_fired(bm(&[4]), 4, 3));
    }

    #[test]
    fn bounty_capped_by_budget() {
        assert_eq!(bounty_for(1_000_000, 30_000, 10_000_000), 2_000_000);
        assert_eq!(bounty_for(1_000_000, 30_000, 500_000), 500_000);
        assert_eq!(bounty_for(1_000_000, 10_000, 9_999_999), 0);
    }

    #[test]
    fn pro_rata_split() {
        assert_eq!(pro_rata(900, 1, 3), 300);
        assert_eq!(pro_rata(100, 5, 0), 0);
    }

    #[test]
    fn word_rules() {
        assert!(validate_word("apple").is_ok());
        assert!(validate_word("Apple").is_err());
        assert!(validate_word("").is_err());
        assert!(validate_word("a".repeat(33).as_str()).is_err());
    }

    #[test]
    fn commitment_binds_setter() {
        let s = [7u8; 32];
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        assert_ne!(commitment("apple", &s, &a), commitment("apple", &s, &b));
    }
}

#[cfg(test)]
mod vectors {
    use super::*;
    fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{:02x}", x)).collect() }
    /// Cross-language vector; packages/shared/test asserts the same values.
    #[test]
    fn print_vectors() {
        let setter = Pubkey::new_from_array([1u8; 32]);
        let c = commitment("apple", &[7u8; 32], &setter);
        let w = word_hash("apple");
        println!("VECTOR commitment={} word_hash={}", hex(&c), hex(&w));
    }
}
