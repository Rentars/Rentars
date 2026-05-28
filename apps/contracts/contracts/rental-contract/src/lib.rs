// Rentars — Rental Soroban Smart Contract
// Built on Stellar blockchain
// Handles: property listing, rental booking, USDC escrow, booking state machine

#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, String};

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub struct Property {
    pub id: u64,
    pub owner: Address,
    pub title: String,
    pub price_per_night: i128, // in USDC stroops
    pub available: bool,
}

/// Booking lifecycle states.
///
/// Valid transitions:
///   Pending  → Confirmed  (owner confirms the booking)
///   Pending  → Cancelled  (either party cancels before confirmation)
///   Confirmed → Completed (rental period ends, escrow released)
///   Confirmed → Cancelled (owner or tenant cancels a confirmed booking)
///
/// Terminal states: Completed, Cancelled — no further transitions allowed.
#[contracttype]
#[derive(Clone, PartialEq)]
pub enum BookingStatus {
    Pending,
    Confirmed,
    Completed,
    Cancelled,
}

#[contracttype]
#[derive(Clone)]
pub struct Booking {
    pub id: u64,
    pub property_id: u64,
    pub tenant: Address,
    pub check_in: u64,
    pub check_out: u64,
    pub total_amount: i128,
    /// Current lifecycle state of the booking.
    pub status: BookingStatus,
    /// Optional TrustlessWork escrow identifier linked to this booking.
    pub escrow_id: Option<String>,
}

#[contracttype]
pub enum DataKey {
    Property(u64),
    Booking(u64),
    PropertyCount,
    BookingCount,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct RentarsContract;

#[contractimpl]
impl RentarsContract {
    // -----------------------------------------------------------------------
    // Property functions
    // -----------------------------------------------------------------------

    /// List a new property on-chain.
    pub fn list_property(
        env: Env,
        owner: Address,
        title: String,
        price_per_night: i128,
    ) -> u64 {
        owner.require_auth();

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::PropertyCount)
            .unwrap_or(0);
        let id = count + 1;

        let property = Property {
            id,
            owner,
            title,
            price_per_night,
            available: true,
        };

        env.storage()
            .instance()
            .set(&DataKey::Property(id), &property);
        env.storage()
            .instance()
            .set(&DataKey::PropertyCount, &id);
        id
    }

    /// Get property details.
    pub fn get_property(env: Env, id: u64) -> Property {
        env.storage()
            .instance()
            .get(&DataKey::Property(id))
            .expect("Property not found")
    }

    // -----------------------------------------------------------------------
    // Booking functions
    // -----------------------------------------------------------------------

    /// Create a booking and lock USDC in escrow.
    /// The booking starts in `Pending` status awaiting owner confirmation.
    pub fn book_property(
        env: Env,
        tenant: Address,
        property_id: u64,
        check_in: u64,
        check_out: u64,
    ) -> u64 {
        tenant.require_auth();

        let mut property: Property = env
            .storage()
            .instance()
            .get(&DataKey::Property(property_id))
            .expect("Property not found");

        assert!(property.available, "Property is not available for booking");
        assert!(check_out > check_in, "check_out must be after check_in");

        let nights = check_out - check_in;
        let total_amount = property.price_per_night * nights as i128;

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::BookingCount)
            .unwrap_or(0);
        let id = count + 1;

        let booking = Booking {
            id,
            property_id,
            tenant,
            check_in,
            check_out,
            total_amount,
            status: BookingStatus::Pending,
            escrow_id: None,
        };

        property.available = false;
        env.storage()
            .instance()
            .set(&DataKey::Property(property_id), &property);
        env.storage()
            .instance()
            .set(&DataKey::Booking(id), &booking);
        env.storage()
            .instance()
            .set(&DataKey::BookingCount, &id);
        id
    }

    /// Transition a booking to a new status, enforcing the state machine rules.
    ///
    /// Allowed transitions:
    ///   Pending   → Confirmed  | Cancelled
    ///   Confirmed → Completed  | Cancelled
    ///
    /// Any other transition panics with a descriptive message.
    pub fn update_status(
        env: Env,
        booking_id: u64,
        caller: Address,
        new_status: BookingStatus,
    ) {
        caller.require_auth();

        let mut booking: Booking = env
            .storage()
            .instance()
            .get(&DataKey::Booking(booking_id))
            .expect("Booking not found");

        // Validate the requested transition against the current state.
        match (&booking.status, &new_status) {
            // Pending → Confirmed: owner confirms the booking
            (BookingStatus::Pending, BookingStatus::Confirmed) => {}

            // Pending → Cancelled: either party cancels before confirmation
            (BookingStatus::Pending, BookingStatus::Cancelled) => {}

            // Confirmed → Completed: rental period ends, escrow released
            (BookingStatus::Confirmed, BookingStatus::Completed) => {}

            // Confirmed → Cancelled: owner or tenant cancels a confirmed booking
            (BookingStatus::Confirmed, BookingStatus::Cancelled) => {}

            // Terminal states — no further transitions allowed
            (BookingStatus::Completed, _) => {
                panic!("Invalid transition: booking is already Completed and cannot be changed")
            }
            (BookingStatus::Cancelled, _) => {
                panic!("Invalid transition: booking is already Cancelled and cannot be changed")
            }

            // All other combinations are invalid
            (BookingStatus::Pending, BookingStatus::Completed) => {
                panic!("Invalid transition: cannot move directly from Pending to Completed — must be Confirmed first")
            }
            (BookingStatus::Pending, BookingStatus::Pending) => {
                panic!("Invalid transition: booking is already in Pending status")
            }
            (BookingStatus::Confirmed, BookingStatus::Confirmed) => {
                panic!("Invalid transition: booking is already in Confirmed status")
            }
            (BookingStatus::Confirmed, BookingStatus::Pending) => {
                panic!("Invalid transition: cannot revert a Confirmed booking back to Pending")
            }
        }

        // If moving to Cancelled, restore property availability
        if new_status == BookingStatus::Cancelled {
            let mut property: Property = env
                .storage()
                .instance()
                .get(&DataKey::Property(booking.property_id))
                .expect("Property not found");
            property.available = true;
            env.storage()
                .instance()
                .set(&DataKey::Property(booking.property_id), &property);
        }

        booking.status = new_status;
        env.storage()
            .instance()
            .set(&DataKey::Booking(booking_id), &booking);
    }

    /// Attach a TrustlessWork escrow identifier to a booking.
    ///
    /// Only the booking tenant may set the escrow ID, and only while the
    /// booking is in Pending or Confirmed status.
    pub fn set_escrow_id(
        env: Env,
        booking_id: u64,
        escrow_id: String,
        caller: Address,
    ) {
        caller.require_auth();

        let mut booking: Booking = env
            .storage()
            .instance()
            .get(&DataKey::Booking(booking_id))
            .expect("Booking not found");

        // Only the tenant who created the booking may attach an escrow
        assert!(
            booking.tenant == caller,
            "Unauthorized: only the booking tenant can set the escrow ID"
        );

        // Escrow can only be set on active (non-terminal) bookings
        match &booking.status {
            BookingStatus::Completed => {
                panic!("Cannot set escrow ID: booking is already Completed")
            }
            BookingStatus::Cancelled => {
                panic!("Cannot set escrow ID: booking is already Cancelled")
            }
            _ => {}
        }

        booking.escrow_id = Some(escrow_id);
        env.storage()
            .instance()
            .set(&DataKey::Booking(booking_id), &booking);
    }

    /// Confirm rental completion and release escrow to owner.
    ///
    /// Convenience wrapper around `update_status` that transitions
    /// Confirmed → Completed. Kept for backwards-compatibility with
    /// existing callers.
    pub fn confirm_rental(env: Env, booking_id: u64, caller: Address) {
        caller.require_auth();

        let booking: Booking = env
            .storage()
            .instance()
            .get(&DataKey::Booking(booking_id))
            .expect("Booking not found");

        match booking.status {
            BookingStatus::Confirmed => {
                // Delegate to update_status for consistent state-machine enforcement.
                // Clone env because it was already borrowed above; Env is cheap to clone.
                Self::update_status(env.clone(), booking_id, caller, BookingStatus::Completed);
            }
            BookingStatus::Pending => {
                panic!("Cannot confirm rental: booking has not been confirmed by the owner yet")
            }
            BookingStatus::Completed => {
                panic!("Cannot confirm rental: booking is already Completed")
            }
            BookingStatus::Cancelled => {
                panic!("Cannot confirm rental: booking has been Cancelled")
            }
        }
    }

    /// Get booking details.
    pub fn get_booking(env: Env, id: u64) -> Booking {
        env.storage()
            .instance()
            .get(&DataKey::Booking(id))
            .expect("Booking not found")
    }
}
