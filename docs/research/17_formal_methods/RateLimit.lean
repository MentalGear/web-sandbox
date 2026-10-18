/-
  S59 proof of concept: src/lib/rate-limit.ts (createRateLimiter) and the guest/host agreement.

  Time and weights are Nat (ms and units). The TypeScript uses doubles: performance.now() is fractional, and
  weights are integers < 2^53, so sums are exact there too. NaN, Infinity and negative weights are NOT modelled
  (Nat cannot express them); see the fast-check comparison for what that hides.
-/

structure Ev where
  t : Nat
  w : Nat
deriving Repr, DecidableEq

def wsum : List Ev → Nat
  | [] => 0
  | e :: es => e.w + wsum es

theorem wsum_append (a b : List Ev) : wsum (a ++ b) = wsum a + wsum b := by
  induction a with
  | nil => simp [wsum]
  | cons x xs ih => simp [wsum, ih]; omega

/-- What is still in the window at `now`: the half-open window (now - W, now], i.e. now < t + W. -/
def live (W now : Nat) (adm : List Ev) : List Ev := adm.filter (fun e => decide (now < e.t + W))

/-! ## 1. The specification: admit iff what is live plus this weight stays within L. -/

def specRun (L W : Nat) : List Ev → List Ev → List Ev
  | adm, [] => adm
  | adm, e :: es =>
    if wsum (live W e.t adm) + e.w ≤ L then specRun L W (adm ++ [e]) es
    else specRun L W adm es

/-- Membership in an arbitrary window [s, s + W). -/
def inWin (W s : Nat) (e : Ev) : Bool := decide (s ≤ e.t ∧ e.t < s + W)

theorem wsum_filter_mono (l : List Ev) (p q : Ev → Bool)
    (h : ∀ x ∈ l, p x = true → q x = true) : wsum (l.filter p) ≤ wsum (l.filter q) := by
  induction l with
  | nil => simp [wsum]
  | cons x xs ih =>
    have ih' := ih (fun y hy => h y (List.mem_cons_of_mem _ hy))
    have hx := h x List.mem_cons_self
    by_cases hp : p x = true
    · have hq := hx hp
      simp [hp, hq, wsum]; omega
    · by_cases hq : q x = true
      · simp [hp, hq, wsum]; omega
      · simp [hp, hq]; exact ih'

/-- The invariant: no window [s, s + W) holds more than L of what was admitted. -/
def Safe (L W : Nat) (adm : List Ev) : Prop := ∀ s, wsum (adm.filter (inWin W s)) ≤ L

theorem safe_step (L W : Nat) (adm : List Ev) (e : Ev)
    (hs : Safe L W adm) (hadm : wsum (live W e.t adm) + e.w ≤ L) : Safe L W (adm ++ [e]) := by
  intro s
  rw [List.filter_append, wsum_append]
  by_cases he : inWin W s e = true
  · simp [he, wsum]
    have hmono : wsum (adm.filter (inWin W s)) ≤ wsum (live W e.t adm) := by
      apply wsum_filter_mono
      intro x _ hx
      simp [inWin] at hx he
      simp; omega
    omega
  · have : List.filter (inWin W s) [e] = [] := by simp [he]
    rw [this]; simp [wsum]; exact hs s

theorem specRun_safe (L W : Nat) : ∀ (es adm : List Ev), Safe L W adm → Safe L W (specRun L W adm es) := by
  intro es
  induction es with
  | nil => intro adm h; simpa [specRun] using h
  | cons e es ih =>
    intro adm h
    simp only [specRun]
    split
    · exact ih _ (safe_step L W adm e h (by assumption))
    · exact ih _ h

/-- **Guarantee**: at most L admitted in ANY window of W ms, whatever the order of the times. -/
theorem rate_limit_safety (L W : Nat) (es : List Ev) (s : Nat) :
    wsum ((specRun L W [] es).filter (inWin W s)) ≤ L :=
  specRun_safe L W es [] (by intro s; simp [wsum]) s

/-! ## 2. The implementation, as rate-limit.ts writes it: a queue (times[head..], weights[head..]),
    a running `total`, `advance` dropping the prefix with times[head] <= now - windowMs, and no entry
    for a weight of 0. Splicing the dropped prefix away is a memory matter only and not modelled. -/

structure Impl where
  q : List Ev
  total : Nat

/-- `while (head < times.length && times[head] <= time - windowMs) { total -= weights[head]; head++ }` -/
def advance (W now : Nat) : List Ev → Nat → List Ev × Nat
  | [], tot => ([], tot)
  | e :: es, tot => if e.t + W ≤ now then advance W now es (tot - e.w) else (e :: es, tot)

def implAdmit (L W : Nat) (st : Impl) (e : Ev) : Bool × Impl :=
  let (q, tot) := advance W e.t st.q st.total
  if tot + e.w > L then (false, ⟨q, tot⟩)
  else (true, ⟨if e.w > 0 then q ++ [e] else q, tot + e.w⟩)

def implRun (L W : Nat) : Impl → List Ev → List Bool
  | _, [] => []
  | st, e :: es => let (b, st') := implAdmit L W st e; b :: implRun L W st' es

def specDecisions (L W : Nat) : List Ev → List Ev → List Bool
  | _, [] => []
  | adm, e :: es =>
    if wsum (live W e.t adm) + e.w ≤ L then true :: specDecisions L W (adm ++ [e]) es
    else false :: specDecisions L W adm es

def Sorted (l : List Ev) : Prop := l.Pairwise (fun a b => a.t ≤ b.t)

theorem advance_total (W now : Nat) : ∀ (q : List Ev) (tot : Nat), tot = wsum q →
    (advance W now q tot).2 = wsum (advance W now q tot).1 := by
  intro q
  induction q with
  | nil => intro tot h; simp [advance, h]
  | cons x xs ih =>
    intro tot h
    simp only [advance]
    split
    · apply ih; simp [wsum] at h; omega
    · simpa using h

/-- On a sorted queue, dropping the expired prefix is the same as filtering what is live. -/
theorem advance_filter (W now : Nat) : ∀ (q : List Ev) (tot : Nat), Sorted q →
    (advance W now q tot).1 = live W now q := by
  intro q
  induction q with
  | nil => intro tot _; simp [advance, live]
  | cons x xs ih =>
    intro tot hs
    have hs' : Sorted xs := (List.pairwise_cons.mp hs).2
    have hle : ∀ y ∈ xs, x.t ≤ y.t := (List.pairwise_cons.mp hs).1
    simp only [advance]
    split
    · rw [ih _ hs']; simp [live, List.filter_cons]; omega
    · rename_i hn
      simp only [live, List.filter_cons]
      have : decide (now < x.t + W) = true := by simp; omega
      rw [this]; simp
      symm; rw [List.filter_eq_self]
      intro y hy; have := hle y hy; simp; omega

theorem live_live (W n m : Nat) (h : m ≤ n) (l : List Ev) : live W n (live W m l) = live W n l := by
  simp only [live, List.filter_filter]
  congr 1; funext x; simp; omega

theorem live_append (W n : Nat) (a b : List Ev) : live W n (a ++ b) = live W n a ++ live W n b := by
  simp [live, List.filter_append]

/-- The refinement invariant between the queue and the admitted history, at time `now`. -/
structure RInv (W now : Nat) (st : Impl) (adm : List Ev) : Prop where
  total : st.total = wsum st.q
  sorted : Sorted st.q
  past : ∀ x ∈ st.q, x.t ≤ now
  same : ∀ n, now ≤ n → wsum (live W n st.q) = wsum (live W n adm)

theorem wsum_live_single (W n : Nat) (e : Ev) (hw : ¬ e.w > 0) : wsum (live W n [e]) = 0 := by
  simp [live, List.filter_cons]; split <;> simp [wsum] <;> omega

/-- **Refinement**: for non-decreasing times (the TS precondition), the implementation makes exactly the
    specification's decisions. -/
theorem impl_refines (L W : Nat) : ∀ (es : List Ev) (st : Impl) (adm : List Ev) (now : Nat),
    RInv W now st adm → Sorted es → (∀ x ∈ es, now ≤ x.t) →
    implRun L W st es = specDecisions L W adm es := by
  intro es
  induction es with
  | nil => intro st adm now _ _ _; simp [implRun, specDecisions]
  | cons e es ih =>
    intro st adm now hinv hsorted hafter
    have hes : Sorted es := (List.pairwise_cons.mp hsorted).2
    have hge : ∀ y ∈ es, e.t ≤ y.t := (List.pairwise_cons.mp hsorted).1
    have hnow : now ≤ e.t := hafter e List.mem_cons_self
    -- after advance
    have hq : (advance W e.t st.q st.total).1 = live W e.t st.q := advance_filter W e.t st.q st.total hinv.sorted
    have htot : (advance W e.t st.q st.total).2 = wsum (live W e.t st.q) := by
      rw [advance_total W e.t st.q st.total hinv.total, hq]
    have hsame : wsum (live W e.t st.q) = wsum (live W e.t adm) := hinv.same e.t hnow
    have hqs : Sorted (live W e.t st.q) := hinv.sorted.filter _
    have hqpast : ∀ x ∈ live W e.t st.q, x.t ≤ e.t := by
      intro x hx; simp [live] at hx; have := hinv.past x hx.1; omega
    simp only [implRun, implAdmit, specDecisions]
    rw [show advance W e.t st.q st.total = (live W e.t st.q, wsum (live W e.t st.q)) by
      ext1 <;> simp [hq, htot]]
    simp only []
    by_cases hfit : wsum (live W e.t adm) + e.w ≤ L
    · have hnot : ¬ (wsum (live W e.t st.q) + e.w > L) := by omega
      simp only [hnot, hfit, ite_false, ite_true]
      congr 1
      apply ih _ _ e.t _ hes hge
      constructor
      · simp only []; split
        · rw [wsum_append]; simp [wsum]
        · simp; omega
      · simp only []; split
        · apply List.pairwise_append.mpr
          refine ⟨hqs, List.pairwise_singleton _ _, ?_⟩
          intro a ha b hb; simp at hb; subst hb; exact hqpast a ha
        · exact hqs
      · intro x hx; simp only [] at hx; split at hx
        · simp at hx; rcases hx with hx | hx
          · exact hqpast x hx
          · subst hx; omega
        · exact hqpast x hx
      · intro n hn
        simp only []
        rw [live_append, wsum_append]
        have h1 : wsum (live W n (live W e.t st.q)) = wsum (live W n adm) := by
          rw [live_live W n e.t hn]; exact hinv.same n (by omega)
        split
        · rw [live_append, wsum_append, h1]
        · rename_i hw; rw [h1, wsum_live_single W n e hw]; simp
    · have hgt : wsum (live W e.t st.q) + e.w > L := by omega
      simp only [hgt, hfit, ite_true, ite_false]
      congr 1
      apply ih _ _ e.t _ hes hge
      exact ⟨by simp, hqs, hqpast, by
        intro n hn; simp only []; rw [live_live W n e.t hn]; exact hinv.same n (by omega)⟩

/-! ## 3. Guest/host agreement. The guest's relay and broker keep the same window (in-sandbox-script.ts,
    slidingWindow) and send only what they admitted; the host re-checks on arrival with its own clock.
    A pair (g, h): g is the event at the guest's send time, h the same event at the host's arrival time. -/

def admitsAll (L W : Nat) : List Ev → List Ev → Prop
  | _, [] => True
  | adm, e :: es => wsum (live W e.t adm) + e.w ≤ L ∧ admitsAll L W (adm ++ [e]) es

/-- Delay never shrinks from an earlier event p to a later one q: a_q - a_p ≥ s_q - s_p (written without
    Nat subtraction), the same weight at both ends, and sends in order. -/
def DelayOK (p q : Ev × Ev) : Prop :=
  p.1.t ≤ q.1.t ∧ q.1.t + p.2.t ≤ q.2.t + p.1.t

theorem wsum_pairs_mono (W : Nat) (cur : Ev × Ev) : ∀ (done : List (Ev × Ev)),
    (∀ p ∈ done, p.2.w = p.1.w ∧ DelayOK p cur) →
    wsum (live W cur.2.t (done.map Prod.snd)) ≤ wsum (live W cur.1.t (done.map Prod.fst)) := by
  intro done
  induction done with
  | nil => intro _; simp [live, wsum]
  | cons p ps ih =>
    intro h
    have ih' := ih (fun x hx => h x (List.mem_cons_of_mem _ hx))
    obtain ⟨hw, h1, h2⟩ := h p List.mem_cons_self
    simp only [live, List.map_cons, List.filter_cons] at ih' ⊢
    by_cases ha : cur.2.t < p.2.t + W
    · have hs : cur.1.t < p.1.t + W := by omega
      simp [ha, hs, wsum, hw]; omega
    · by_cases hs : cur.1.t < p.1.t + W
      · simp [ha, hs, wsum]; omega
      · simp [ha, hs]; exact ih'

/-- **Agreement**: if the guest admitted every event it sent, and the transit delay never shrinks, the host
    admits every one of them too. -/
theorem agreement (L W : Nat) : ∀ (rest done : List (Ev × Ev)),
    (∀ p ∈ done ++ rest, p.2.w = p.1.w) →
    (done ++ rest).Pairwise DelayOK →
    admitsAll L W (done.map Prod.fst) (rest.map Prod.fst) →
    admitsAll L W (done.map Prod.snd) (rest.map Prod.snd) := by
  intro rest
  induction rest with
  | nil => intro _ _ _ _; simp [admitsAll]
  | cons c cs ih =>
    intro done hw hp hg
    simp only [List.map_cons, admitsAll] at hg ⊢
    obtain ⟨hgc, hgs⟩ := hg
    have hcw : c.2.w = c.1.w := hw c (by simp)
    have hrel : ∀ p ∈ done, p.2.w = p.1.w ∧ DelayOK p c := by
      intro p hpm
      refine ⟨hw p (by simp [hpm]), ?_⟩
      have := List.pairwise_append.mp hp
      exact this.2.2 p hpm c (by simp)
    have hmono := wsum_pairs_mono W c done hrel
    refine ⟨by omega, ?_⟩
    have := ih (done ++ [c]) (by simpa using hw) (by simpa using hp) (by simpa using hgs)
    simpa using this

/-! ## 4. Without the delay condition it fails: a host busy for 500 ms delivers the first line late. -/

def guestSends : List Ev := [⟨0, 1⟩, ⟨1000, 1⟩]
def hostSees   : List Ev := [⟨500, 1⟩, ⟨1000, 1⟩]   -- delay 500 then 0: it shrank

example : specDecisions 1 1000 [] guestSends = [true, true] := by decide
example : specDecisions 1 1000 [] hostSees = [true, false] := by decide

/-! ## 5. The refinement needs non-decreasing time (rate-limit.ts states it). With time going back, an advance
    at t = 1000 (here a 0-weight admit; in TS also `fits`) drops t = 0, and t = 500 is then admitted: two in [0, 1000). -/
example : implRun 1 1000 ⟨[], 0⟩ [⟨0, 1⟩, ⟨1000, 0⟩, ⟨500, 1⟩] = [true, true, true] := by decide
example : specDecisions 1 1000 [] [⟨0, 1⟩, ⟨1000, 0⟩, ⟨500, 1⟩] = [true, true, false] := by decide
