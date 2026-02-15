# Test Cases for Troubleshooting System

## Test Scenarios

### 1. Clear Question Test
**User Query**: "How do I fix error code 123?"

**Expected Behavior**:
- LLM searches for relevant process using `searchProcesses`
- Retrieves process details using `getProcessDetails`
- Provides step-by-step instructions from JSON
- No clarification needed

**Success Criteria**:
- Answer matches process JSON exactly
- No invented steps
- All prerequisites mentioned

---

### 2. Ambiguous Question Test
**User Query**: "The printer isn't working"

**Expected Behavior**:
- LLM recognizes ambiguity
- Uses `askClarification` tool
- Presents options: paper jam, no power, connection issues, etc.
- Waits for user selection
- Provides specific process after clarification

**Success Criteria**:
- Clarification question is clear
- Options are based on available processes
- Doesn't guess which problem

---

### 3. Out-of-Scope Question Test
**User Query**: "How do I install the software?"

**Expected Behavior**:
- LLM searches processes
- Finds no matching process
- Politely declines: "I don't have information about that"
- Lists available processes

**Success Criteria**:
- Clear refusal without hallucination
- Helpful pointer to what IS available
- No invented answer

---

### 4. Multi-Step Follow-Up Test
**Conversation**:
1. User: "Help me fix the paper jam"
2. Assistant: [Provides step 1]
3. User: "I completed step 1, what's next?"

**Expected Behavior**:
- LLM maintains context
- Provides step 2 from same process
- Continues sequential flow

**Success Criteria**:
- Correct step order maintained
- No repeated steps
- Context preserved

---

### 5. Conditional Path Test
**User Query**: "I see error code on printer"

**Process has decision point**: "Can you see the jammed paper?"

**Expected Behavior**:
- LLM reaches decision point
- Asks the exact question from JSON
- Routes to correct next step based on answer
- Follows conditional logic

**Success Criteria**:
- Decision point question matches JSON
- Correct step routing
- Handles both Yes/No paths

---

## Evaluation Checklist

For each test:
- [ ] Process extracted correctly from document
- [ ] JSON validates against schema
- [ ] LLM uses correct tools
- [ ] Answer is factually correct per JSON
- [ ] No hallucinated information
- [ ] Clarification handled properly
- [ ] Error messages are helpful
- [ ] Conversation flow is natural

---

## Known Edge Cases

1. **Multiple matching processes**: Should ask which one
2. **Missing prerequisites**: Should warn user
3. **Incomplete process in JSON**: Should acknowledge limitation
4. **User skips steps**: Should warn about sequential nature
5. **Process has no decision points**: Should be linear