import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import BulkApiKeyManager from './BulkApiKeyManager';
import UserManual from './UserManual';
import DonationButton from './DonationButton';
import { useApiKeyManager, ApiKeyStatus } from '@/hooks/useApiKeyManager';

interface MCQ {
  question: string;
  options: string[];
  correct: string;
  explanation: string;
  selected: string | null;
}

interface Progress {
  current: number;
  total: number;
  speed: number;
  elapsed: number;
}

declare global {
  interface Window {
    pdfjsLib: any;
  }
}

// Helper to normalize question text for comparison
const normalizeQuestion = (q: string | undefined | null): string => {
  if (!q || typeof q !== 'string') return '';
  return q.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 100);
};

// Remove duplicate questions
const deduplicateMCQs = (mcqs: MCQ[]): MCQ[] => {
  if (!mcqs || !Array.isArray(mcqs)) return [];
  const seen = new Set<string>();
  return mcqs.filter(mcq => {
    if (!mcq || !mcq.question) return false;
    const key = normalizeQuestion(mcq.question);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const getGeminiUrl = (key: string) => 
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;

const SSCMCQGenerator = () => {
  const navigate = useNavigate();
  const {
    apiKeys,
    getNextAvailableKey,
    markKeyRateLimited,
    resetKeyUsage,
    getAvailableKeyCount,
    getKeyStatuses
  } = useApiKeyManager();
  
  const [difficulty, setDifficulty] = useState('hard+easy');
  const [count, setCount] = useState(10);
  const [autoCount, setAutoCount] = useState(true);
  const [estimatedCount, setEstimatedCount] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<Progress>({ current: 0, total: 0, speed: 0, elapsed: 0 });
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [pdfLibLoaded, setPdfLibLoaded] = useState(false);
  const [keyStatuses, setKeyStatuses] = useState<ApiKeyStatus[]>(getKeyStatuses());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const processingRef = useRef({ startTime: 0, completed: 0 });
  
  const totalKeys = apiKeys.length;
  
  // Update key statuses every 500ms during processing
  useEffect(() => {
    if (!processing) return;
    
    const interval = setInterval(() => {
      setKeyStatuses(getKeyStatuses());
    }, 500);
    
    return () => clearInterval(interval);
  }, [processing, getKeyStatuses]);

  useEffect(() => {
    const loadPdfLib = async () => {
      try {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js';
        
        const loadPromise = new Promise((resolve, reject) => {
          script.onload = resolve;
          script.onerror = reject;
        });
        
        document.head.appendChild(script);
        await loadPromise;
        
        if (window.pdfjsLib) {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = 
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
          setPdfLibLoaded(true);
        } else {
          setError('PDF library loaded but not available. Please refresh.');
        }
      } catch (err) {
        setError('Failed to load PDF library. Check your internet connection and refresh.');
      }
    };
    
    loadPdfLib();
  }, []);

  // Comprehensive PDF analysis to calculate exact MCQs needed for FULL coverage
  const estimateMCQCount = async (file: File): Promise<number> => {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const numPages = pdf.numPages;
      
      // Extract text from ALL pages for accurate analysis
      let totalContent = '';
      let totalChars = 0;
      let totalWords = 0;
      let factDensityScore = 0;
      
      // Sample more pages for better accuracy (up to 20 pages or all if fewer)
      const samplesToTake = Math.min(20, numPages);
      const sampleIndices: number[] = [];
      
      // Distributed sampling across entire PDF
      for (let i = 0; i < samplesToTake; i++) {
        sampleIndices.push(Math.floor((i / samplesToTake) * numPages) + 1);
      }
      
      for (const pageNum of sampleIndices) {
        const text = await extractPageText(pdf, pageNum);
        if (text) {
          totalContent += text + ' ';
          totalChars += text.length;
          totalWords += text.split(/\s+/).filter(w => w.length > 2).length;
          
          // Analyze fact density: count numbers, dates, proper nouns, key terms
          const numbers = (text.match(/\b\d+\b/g) || []).length;
          const dates = (text.match(/\b(19|20)\d{2}\b/g) || []).length;
          const articles = (text.match(/\bArticle\s+\d+/gi) || []).length;
          const properNouns = (text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || []).length;
          const keyTerms = (text.match(/\b(scheme|act|committee|commission|policy|treaty|amendment|constitution|government|ministry|department)\b/gi) || []).length;
          
          factDensityScore += numbers + (dates * 2) + (articles * 3) + (properNouns * 0.5) + (keyTerms * 2);
        }
      }
      
      // Extrapolate to full PDF
      const avgCharsPerPage = totalChars / samplesToTake;
      const avgWordsPerPage = totalWords / samplesToTake;
      const avgFactDensity = factDensityScore / samplesToTake;
      
      const estimatedTotalChars = avgCharsPerPage * numPages;
      const estimatedTotalWords = avgWordsPerPage * numPages;
      const estimatedTotalFactDensity = avgFactDensity * numPages;
      
      // Calculate MCQs needed using multiple factors:
      // 1. Character-based: 1 MCQ per 300 chars for comprehensive coverage
      const byChars = Math.ceil(estimatedTotalChars / 300);
      
      // 2. Word-based: 1 MCQ per 80 words
      const byWords = Math.ceil(estimatedTotalWords / 80);
      
      // 3. Fact density: More facts = more MCQs needed
      const byFacts = Math.ceil(estimatedTotalFactDensity / 3);
      
      // 4. Page-based minimum: At least 5 MCQs per page for thorough coverage
      const byPages = numPages * 5;
      
      // Weighted average prioritizing fact coverage
      const calculated = Math.round(
        (byChars * 0.2) + 
        (byWords * 0.2) + 
        (byFacts * 0.3) + 
        (byPages * 0.3)
      );
      
      // Ensure minimum coverage and cap at 500
      const estimated = Math.min(500, Math.max(20, calculated));
      
      console.log(`PDF Analysis: ${numPages} pages, ~${Math.round(estimatedTotalWords)} words, Fact density: ${Math.round(estimatedTotalFactDensity)}, Estimated MCQs: ${estimated}`);
      
      return estimated;
    } catch (err) {
      console.error('PDF analysis error:', err);
      // Fallback: 5 MCQs per page minimum
      return 50;
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && pdfLibLoaded && autoCount) {
      setStatus('📊 Deep analyzing PDF: scanning pages, counting facts, measuring density...');
      const estimated = await estimateMCQCount(file);
      setEstimatedCount(estimated);
      setCount(estimated);
      setStatus('');
    }
  };

  const updateProgress = (completed: number, total: number) => {
    const elapsed = (Date.now() - processingRef.current.startTime) / 1000;
    const speed = elapsed > 0 ? Math.round((completed / elapsed) * 60) : 0;
    setProgress({ current: completed, total, speed, elapsed: Math.round(elapsed) });
  };

  const extractPageText = async (pdf: any, pageNum: number): Promise<string | null> => {
    try {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const text = textContent.items.map((item: any) => item.str).join(' ');
      if (text.trim().length > 50) return text;
    } catch (e) {}
    return null;
  };

  const extractPageImage = async (pdf: any, pageNum: number): Promise<string> => {
    const page = await pdf.getPage(pageNum);
    const scale = 1.5; // Better quality for OCR
    const viewport = page.getViewport({ scale });
    
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: false });
    canvas.height = viewport.height;
    canvas.width = viewport.width;
    
    await page.render({ canvasContext: context, viewport }).promise;
    
    const imageData = canvas.toDataURL('image/jpeg', 0.6); // Better quality for OCR
    canvas.remove();
    
    return imageData.split(',')[1];
  };

  const processPageWithOCR = async (pdf: any, pageNum: number, retryCount = 0): Promise<string | null> => {
    try {
      // Add small delay before OCR to respect rate limits
      if (retryCount > 0) {
        await new Promise(r => setTimeout(r, 2000 * retryCount));
      }
      
      const base64Data = await extractPageImage(pdf, pageNum);
      const keyData = getNextAvailableKey();
      if (!keyData) {
        console.log(`OCR page ${pageNum}: No available keys`);
        return null;
      }
      
      console.log(`OCR page ${pageNum}: Using key ${keyData.index + 1}/${totalKeys}`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      
      const response = await fetch(getGeminiUrl(keyData.key), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{
            parts: [
              { 
                inline_data: { 
                  mime_type: "image/jpeg", 
                  data: base64Data 
                }
              },
              { text: "Extract ALL text from this image completely. Return only the extracted text, nothing else." }
            ]
          }],
          generationConfig: {
            maxOutputTokens: 4000
          }
        })
      });
      
      clearTimeout(timeoutId);
      
      if (response.ok) {
        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text && text.length > 20) return text;
      } else if (response.status === 429) {
        // Rate limited - mark key and retry with different key
        markKeyRateLimited(keyData.key);
        console.log(`OCR page ${pageNum}: Key ${keyData.index + 1} rate limited, retrying...`);
        if (retryCount < 3) {
          return processPageWithOCR(pdf, pageNum, retryCount + 1);
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError' && retryCount < 2) {
        console.log(`OCR page ${pageNum}: Timeout, retrying...`);
        return processPageWithOCR(pdf, pageNum, retryCount + 1);
      }
      console.error(`OCR error page ${pageNum}:`, err?.message);
    }
    return null;
  };

  const processPDFOptimized = async (pdf: any): Promise<string> => {
    const totalPages = pdf.numPages;
    const allContent: string[] = [];
    processingRef.current = { startTime: Date.now(), completed: 0 };
    
    // First pass: try text extraction for all pages
    setStatus(`📄 Extracting text from ${totalPages} pages...`);
    const textPages: { pageNum: number; text: string | null }[] = [];
    
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const text = await extractPageText(pdf, pageNum);
      textPages.push({ pageNum, text });
      processingRef.current.completed++;
      updateProgress(processingRef.current.completed, totalPages * 2);
    }
    
    // Check if we need OCR (most pages have no text)
    const pagesWithText = textPages.filter(p => p.text !== null).length;
    const needsOCR = pagesWithText < totalPages * 0.3;
    
    if (needsOCR) {
      setStatus(`🔍 Scanned PDF detected. Running OCR on ${totalPages} pages...`);
      
      // Process pages sequentially with small delays to avoid rate limiting
      const CONCURRENT_OCR = 3; // Lower concurrency for OCR
      
      for (let i = 0; i < totalPages; i += CONCURRENT_OCR) {
        const batch: Promise<string | null>[] = [];
        
        for (let j = 0; j < CONCURRENT_OCR && i + j < totalPages; j++) {
          const pageNum = i + j + 1;
          const existingText = textPages[i + j]?.text;
          
          if (existingText) {
            batch.push(Promise.resolve(existingText));
          } else {
            batch.push(
              new Promise(async (resolve) => {
                await new Promise(r => setTimeout(r, j * 500)); // Stagger requests
                const text = await processPageWithOCR(pdf, pageNum);
                resolve(text);
              })
            );
          }
        }
        
        const results = await Promise.all(batch);
        
        for (let j = 0; j < results.length; j++) {
          const pageNum = i + j + 1;
          const text = results[j];
          if (text) {
            allContent.push(`--- Page ${pageNum} ---\n${text}\n`);
          }
          processingRef.current.completed++;
          updateProgress(processingRef.current.completed, totalPages * 2);
        }
        
        // Delay between batches
        if (i + CONCURRENT_OCR < totalPages) {
          await new Promise(r => setTimeout(r, 800));
        }
      }
    } else {
      // Use extracted text
      for (const page of textPages) {
        if (page.text) {
          allContent.push(`--- Page ${page.pageNum} ---\n${page.text}\n`);
        }
        processingRef.current.completed++;
        updateProgress(processingRef.current.completed, totalPages * 2);
      }
    }
    
    const finalContent = allContent.join('\n');
    console.log(`PDF processed: ${allContent.length} pages with content, ${finalContent.length} chars`);
    return finalContent;
  };

  const generateMCQsBatch = async (content: string, numQuestions: number, batchNum: number, totalBatches: number, pageInfo: string, setStatusFn: (s: string) => void, difficultyLevel: string = 'hard+easy'): Promise<MCQ[]> => {
    // Guard against invalid inputs
    if (!content || typeof content !== 'string' || content.trim().length < 50) {
      console.log(`Batch ${batchNum}: Skipping - content too short or invalid`);
      return [];
    }
    
    if (!numQuestions || numQuestions < 1 || isNaN(numQuestions)) {
      console.log(`Batch ${batchNum}: Invalid numQuestions: ${numQuestions}`);
      return [];
    }

    // Safe content extraction
    const safeContent = String(content || '').substring(0, 50000);
    
    // Get current date for exam trends — always reference previous year to today
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const prevYear = currentYear - 1;
    const trendPeriod = `${prevYear} to ${currentYear}`;
    const examYearList = `CGL ${prevYear}, CGL ${currentYear}, CHSL ${prevYear}, CHSL ${currentYear}, MTS ${prevYear}, MTS ${currentYear}, GD ${prevYear}, GD ${currentYear}, CPO ${prevYear}, CPO ${currentYear}, Stenographer ${prevYear}, Stenographer ${currentYear}`;

    // EXACT DIFFICULTY LEVEL INSTRUCTIONS
    let difficultyInstructions = '';
    let questionTypeRatio = '';
    
    if (difficultyLevel === 'easy') {
      difficultyInstructions = `
🎯 DIFFICULTY LEVEL: EASY (Basic Recall Questions Only)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Generate ONLY EASY questions that test DIRECT RECALL of facts:
• Simple "What is", "Who is", "When was" type questions
• Direct fact-based questions with straightforward answers
• Single-concept questions (no multi-step reasoning required)
• Questions where the answer is EXPLICITLY stated in one sentence
• Basic definition, name, date, place identification questions

❌ DO NOT INCLUDE:
• Application-based questions
• Analysis or comparison questions  
• Questions requiring inference or reasoning
• "Which of the following" elimination-style questions
• Questions combining multiple concepts

✅ EASY QUESTION EXAMPLES:
• "What is the capital of [country]?"
• "Who founded [organization]?"
• "In which year was [event] established?"
• "What is [term] called?"
• "[Person] is known as the father of ____?"`;
      questionTypeRatio = '100% Basic Recall Questions';
    } else if (difficultyLevel === 'hard') {
      difficultyInstructions = `
🎯 DIFFICULTY LEVEL: HARD (Complex Reasoning Questions Only)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Generate ONLY HARD questions that require DEEP ANALYSIS and REASONING:
• Multi-step reasoning questions
• Compare and contrast questions
• Application of concepts to new scenarios
• "Which of the following is INCORRECT" elimination questions
• Questions combining 2-3 related concepts
• Analytical questions requiring inference
• Assertion-Reason type questions
• Statement-based questions (Which statements are correct?)

❌ DO NOT INCLUDE:
• Simple recall questions
• Direct "What is" or "Who is" questions
• Single-fact identification questions
• Questions with obvious answers

✅ HARD QUESTION EXAMPLES:
• "Which of the following statements about [topic] is/are INCORRECT?"
• "Consider the following statements... Which is/are correct?"
• "Arrange the following [events] in chronological order"
• "Match List-I with List-II and select the correct answer"
• "The [concept] differs from [concept] in terms of..."
• "If [scenario], then which of the following would be true?"`;
      questionTypeRatio = '100% Complex Reasoning Questions';
    } else {
      // hard+easy (default - balanced mix)
      difficultyInstructions = `
🎯 DIFFICULTY LEVEL: MIXED (50% Easy + 50% Hard)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Generate a BALANCED MIX of EXACTLY 50% Easy and 50% Hard questions:

📗 EASY QUESTIONS (50% of total - ${Math.ceil(numQuestions/2)} questions):
• Simple "What is", "Who is", "When was" type questions
• Direct fact recall from single sentences
• Basic definition and identification questions

📕 HARD QUESTIONS (50% of total - ${Math.floor(numQuestions/2)} questions):
• Multi-step reasoning and analysis questions
• "Which of the following is INCORRECT" type
• Compare/contrast and application questions
• Statement-based analytical questions

⚠️ STRICT REQUIREMENT: Alternate between Easy and Hard questions.
• Q1: Easy, Q2: Hard, Q3: Easy, Q4: Hard... and so on
• Each question must be clearly either Easy OR Hard level
• Do NOT make all questions the same difficulty`;
      questionTypeRatio = '50% Basic Recall + 50% Complex Reasoning (Alternating)';
    }

     const prompt = `You are the ACTUAL SSC EXAM PAPER SETTER who has designed questions for ${examYearList} papers. Your job is to produce questions INDISTINGUISHABLE from real SSC papers.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛑 ZERO HALLUCINATION PROTOCOL (HIGHEST PRIORITY):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

MANDATORY 2-PASS WORKFLOW (do this silently, do NOT print Pass 1):

PASS 1 — FACT EXTRACTION (internal, do not output):
  • Read the SOURCE CONTENT below sentence by sentence.
  • Build an internal list of ATOMIC FACTS in the exact form: [SUBJECT] — [RELATION] — [OBJECT] — (verbatim quote, ≤25 words).
  • Only include facts where SUBJECT, RELATION, and OBJECT are ALL explicitly written in the PDF (no inference, no synonyms, no merging across paragraphs).
  • Discard any fact that is vague, incomplete, opinion-based, or appears in a heading/footer/page number.
  • Rank facts by SSC exam value (superlatives, dates, articles, schemes, capitals, inventors, alloys, vitamins, HQ, nicknames, etc.).

PASS 2 — QUESTION GENERATION (this is what you output):
  • Use ONLY facts from your Pass 1 list. One question per fact. Never reuse the same fact twice.
  • For every question you write, the correct option MUST appear verbatim (or as a direct paraphrase of a noun phrase) in the source PDF.

VERIFICATION CHECKLIST (apply to every single question before writing it):
1. QUOTE CHECK: You can point to the EXACT sentence in the PDF that contains the answer. If not → SKIP.
2. ANSWER VERIFICATION: The correct answer is EXPLICITLY stated in the PDF — no rounding, no approximation, no synonym swap.
3. OPTION VERIFICATION: All 4 options are REAL entities from the SAME category, era, and domain. Distractors must be plausible to a well-prepared SSC aspirant — never absurd, never from a different topic.
4. UNIQUENESS: Exactly ONE option is correct. No second option is even partially correct.
5. SELF-CONTAINED: A student reading ONLY the question (no PDF, no passage) can understand and attempt it.
6. AMBIGUITY RULE: If the fact is unclear, contradicted elsewhere in the PDF, or has multiple valid readings → SKIP IT.
7. NO INFERENCE RULE: Do NOT combine two facts. Do NOT compute. Do NOT draw conclusions. Each question tests ONE explicitly stated fact.
8. NO META RULE: Never reference "the passage", "the text", "the chapter", "the author says", "as mentioned above", "given data", or page numbers.

${difficultyInstructions}

📊 QUESTION TYPE RATIO: ${questionTypeRatio}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎯 REPLICATE EXACT SSC EXAM STANDARD (${trendPeriod}):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Your questions must match the EXACT style, difficulty, and language of questions asked in recent SSC exams. Study these REAL SSC question patterns and replicate them precisely:

📌 REAL SSC CGL ${prevYear}-${currentYear} PATTERN EXAMPLES:
• "The Palk Strait separates India from which country?" → Direct, one-fact, no ambiguity
• "Who was the first Governor-General of independent India?" → Tests specific 'first/last' facts
• "Article 370 of the Indian Constitution was related to which state?" → Constitutional article + specific link
• "Which Five Year Plan adopted the objective of 'Removal of Poverty'?" → Scheme/Plan + exact detail
• "Arrange the following events in chronological order: I. Battle of Plassey II. Battle of Buxar III. Battle of Panipat" → Sequencing with close-era events
• "Consider the following statements about the President of India: 1) Must be 35+ years 2) Must be a member of Lok Sabha. Which is/are correct?" → Statement verification with traps

📌 REAL SSC CHSL ${prevYear}-${currentYear} PATTERN:
• "Which river is known as 'Sorrow of Bihar'?" → Nickname/alias questions
• "Brass is an alloy of which metals?" → Composition/constituent questions
• "Who authored the book 'Discovery of India'?" → Direct author-book pairs
• "Which vitamin deficiency causes Night Blindness?" → Cause-effect medical/science facts

📌 REAL SSC MTS/GD ${prevYear}-${currentYear} PATTERN:
• "The headquarters of UNESCO is located in?" → HQ location questions
• "Mahatma Gandhi started the Dandi March in which year?" → Event + exact year
• "Which state has the longest coastline in India?" → Superlative geographic facts

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 QUESTION CRAFTING — MATCH SSC EXACTLY:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 1 - EXTRACT: List ONLY facts clearly stated with specific data (names, dates, numbers, places).

STEP 2 - RANK BY ${trendPeriod} EXAM FREQUENCY: Prioritize facts SSC has ACTUALLY asked in recent papers.

STEP 3 - FRAME using EXACT SSC wording patterns:
  • "Which of the following [specific domain]...?" (40% of SSC questions use this)
  • "Consider the following statements: 1)... 2)... 3)... Which of the above is/are correct?" (CGL Tier-1 signature — use "Which of the above", NOT "Which of the following")
  • "Match List-I with List-II and select the correct answer using the code given below" (exact SSC phrasing)
  • "Arrange the following in chronological/ascending/descending order and select the correct answer"
  • "Who among the following...?" / "Which one of the following is NOT correctly matched?"
  • Direct: "[Specific entity] is related to/located in/established in?"

CRITICAL LANGUAGE RULES (match SSC exactly):
  • Use "Select the correct answer" NOT "Choose the correct option"
  • Use "Which of the following" NOT "Which one of these"
  • Use "is/are correct" NOT "is/are true"
  • Options labeled A), B), C), D) — NOT (a), (b), (c), (d)
  • Question must be complete, self-contained, no reference to passage/text/chapter
  • Use formal English, no contractions, Class 10 vocabulary

STEP 4 - DISTRACTOR ENGINEERING (SSC-level traps):

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🏆 SSC EXAM TOPIC PRIORITY:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔴 MOST ASKED IN SSC (60%):
  - First/Largest/Smallest/Longest/Highest superlative facts
  - Exact years: establishment, battles, treaties, acts, schemes
  - Constitutional Articles & Amendments with specific provisions
  - Government schemes: launch year, ministry, beneficiaries, budget
  - Rivers: origin, tributaries, dams, "Sorrow of" nicknames
  - National Parks, Wildlife Sanctuaries with states
  - Books-Authors, Inventions-Inventors with years
  - Vitamins, Diseases, Deficiency links
  - SI Units, Scientific instruments, Chemical formulas

🟡 FREQUENTLY ASKED (30%):
  - Committees/Commissions with chairperson and key recommendations
  - International organizations: HQ, establishment year, head, members
  - Historical battles/treaties with exact years and parties
  - Sports trophies, folk dances-states, classical dances-states
  - Economic terms, GDP components, Five Year Plans

🟢 SUPPLEMENTARY (10%):
  - Definitions of technical terms explicitly stated in PDF
  - Process-based facts (e.g., "Photosynthesis occurs in...")

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚡ DISTRACTOR RULES (SSC-STANDARD):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. ALL 4 options SAME category, SAME era, SAME difficulty to eliminate
2. YEAR questions: correct=1950 → distractors 1947, 1952, 1956 (adjacent, confusable years)
3. PERSON questions: same field, same era (e.g., all freedom fighters from 1900-1950)
4. PLACE questions: same region/type (e.g., all southern Indian rivers)
5. Include the MOST COMMONLY CONFUSED answer as one distractor (the "SSC trap")
6. Distribute correct answer position evenly across A/B/C/D
7. Options in logical order: years ascending, names alphabetical, values ascending

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📝 OUTPUT FORMAT (STRICT — SSC PAPER FORMAT):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Q1. [Exact SSC-style question — reads like it was copied from an SSC paper]
A. [Real, plausible option from same category]
B. [Real, plausible option from same category]
C. [Real, plausible option from same category]
D. [Real, plausible option from same category]
Correct Answer: [A/B/C/D]
Explanation (Testbook Style): [6-8 sentences: ① Correct answer with EXACT proof from PDF ② Clear explanation ③ Why Option X is wrong (with real fact) ④ Why Option Y is wrong ⑤ Why Option Z is wrong ⑥ Memory trick/mnemonic ⑦ "This topic was asked in SSC [exam name] [year]" relevance note ⑧ Related fact worth remembering]

Q2. [Next question...]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚫 ABSOLUTE PROHIBITIONS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ NEVER fabricate or hallucinate any fact not explicitly in the PDF
❌ NEVER use training knowledge to fill gaps — ONLY PDF content
❌ NEVER create a question if less than 100% certain answer is in PDF
❌ NEVER ask "What is discussed in this chapter/passage?"
❌ NEVER ask "According to the passage/text..." (SSC never does this)
❌ NEVER use "All of the above" or "None of the above"
❌ NEVER make two options obviously wrong
❌ NEVER repeat the same concept in multiple questions
❌ NEVER ask opinion/subjective questions
❌ NEVER include "Cannot be determined" or "Not mentioned"
❌ NEVER write questions that sound like classroom quizzes — they must sound like REAL EXAM questions
❌ If a fact is ambiguous → SKIP IT entirely
❌ If unsure about any detail → DO NOT include it

✅ MANDATORY:
✅ Every question must be INDISTINGUISHABLE from a real SSC paper question
✅ Every correct answer has direct, traceable source in PDF
✅ Simple English, Class 10 vocabulary, formal tone
✅ Exact names/dates/numbers AS WRITTEN in PDF
✅ One clear concept per question, independently answerable
✅ Difficulty: ${difficultyLevel.toUpperCase()} as specified above
✅ Accuracy > Quantity — fewer accurate questions beats more inaccurate ones
✅ Question language must match official SSC English medium paper tone

📄 SOURCE CONTENT (${pageInfo}):
${safeContent}

Generate EXACTLY ${numQuestions} SSC-EXAM-IDENTICAL ${difficultyLevel.toUpperCase()} MCQs. Every question must read as if lifted directly from an SSC ${trendPeriod} paper. ONLY use facts explicitly present above. If content doesn't support ${numQuestions} accurate questions, generate fewer with 100% accuracy.`;

    // Try up to 10 different API keys with proper rotation
    for (let attempt = 0; attempt < Math.min(10, totalKeys); attempt++) {
      // Progressive backoff between retries
      if (attempt > 0) {
        const backoffMs = Math.min(1500 * Math.pow(1.5, attempt - 1), 10000);
        await new Promise(r => setTimeout(r, backoffMs));
      }
      
      const keyData = getNextAvailableKey();
      if (!keyData) {
        console.log(`Batch ${batchNum}: All API keys rate limited! Waiting 30s...`);
        await new Promise(r => setTimeout(r, 30000));
        const retryKey = getNextAvailableKey();
        if (!retryKey) return [];
        continue;
      }
      
      try {
        setStatusFn(`📝 Batch ${batchNum}/${totalBatches} - ${pageInfo} (Key ${keyData.index + 1}/${totalKeys})...`);
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000); // 120s timeout for larger batches
        
        const response = await fetch(getGeminiUrl(keyData.key), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              maxOutputTokens: Math.min(numQuestions * 1200, 24000),
              temperature: 0.01, // Near-zero temperature: maximum determinism, zero hallucination
              topP: 0.85,
              topK: 10
            }
          })
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          const status = response.status;
          console.log(`Batch ${batchNum} API error: ${status} on key ${keyData.index + 1}`);
          
          if (status === 429) {
            markKeyRateLimited(keyData.key);
            console.log(`Key ${keyData.index + 1} rate limited, rotating to next key...`);
            continue; // Rotation delay handled at top of loop
          }
          
          continue;
        }
        
        const data = await response.json();
        const mcqText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (!mcqText || typeof mcqText !== 'string' || mcqText.trim().length < 50) {
          console.log(`Batch ${batchNum}: Empty/invalid response from key ${keyData.index + 1}`);
          continue;
        }
        
        const mcqs = parseMCQs(mcqText);
        console.log(`Batch ${batchNum}: Generated ${mcqs.length}/${numQuestions} MCQs using key ${keyData.index + 1}`);
        
        if (mcqs.length > 0) {
          return mcqs;
        }
        
      } catch (err: any) {
        if (err.name === 'AbortError') {
          console.log(`Batch ${batchNum}: Request timeout on key ${keyData.index + 1}`);
        } else {
          console.error(`Batch ${batchNum} error on key ${keyData.index + 1}:`, err?.message || err);
        }
      }
    }
    
    return [];
  };

  const generateMCQs = async (content: string, numQuestions: number): Promise<MCQ[]> => {
    // Validate inputs
    if (!content || typeof content !== 'string' || content.trim().length < 100) {
      setError('PDF content too short. Please use a different PDF.');
      return [];
    }
    
    if (!numQuestions || numQuestions < 1 || isNaN(numQuestions)) {
      setError('Invalid number of questions requested.');
      return [];
    }

    resetKeyUsage();
    
    // Split content into pages - with safe string handling
    const safeContent = String(content || '');
    let pages: string[] = [];
    
    try {
      pages = safeContent.split(/(?=--- Page \d+ ---)/).filter(p => p && typeof p === 'string' && p.trim().length > 100);
    } catch (e) {
      console.error('Error splitting pages:', e);
    }
    
    if (pages.length === 0) {
      // Smart chunking: split at paragraph/section boundaries instead of arbitrary positions
      const chunkSize = 35000;
      let pos = 0;
      while (pos < safeContent.length) {
        let end = Math.min(pos + chunkSize, safeContent.length);
        // Try to split at a paragraph boundary (double newline) within last 20% of chunk
        if (end < safeContent.length) {
          const searchStart = Math.max(pos + Math.floor(chunkSize * 0.8), pos);
          const segment = safeContent.substring(searchStart, end);
          const lastParagraph = segment.lastIndexOf('\n\n');
          if (lastParagraph > 0) {
            end = searchStart + lastParagraph;
          } else {
            // Fallback: split at sentence boundary
            const lastSentence = segment.lastIndexOf('. ');
            if (lastSentence > 0) {
              end = searchStart + lastSentence + 2;
            }
          }
        }
        const chunk = safeContent.substring(pos, end);
        if (chunk && chunk.trim().length > 100) {
          pages.push(chunk);
        }
        pos = end;
      }
    }
    
    if (pages.length === 0 && safeContent.trim().length > 100) {
      pages = [safeContent.substring(0, 40000)];
    }
    
    if (pages.length === 0) {
      setError('Could not extract content from PDF.');
      return [];
    }

    console.log(`Processing ${pages.length} content chunks for ${numQuestions} MCQs`);

    // EQUAL PROPORTIONAL DISTRIBUTION across ALL pages
    // Base questions per page + distribute remainder evenly
    const baseQuestionsPerPage = Math.floor(numQuestions / pages.length);
    const extraQuestions = numQuestions % pages.length;
    
    // Create batches with STRICTLY EQUAL DISTRIBUTION across all pages
    const batches: { content: string; questions: number; pageInfo: string }[] = [];
    
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      // First 'extraQuestions' pages get 1 extra question each for perfect distribution
      const questionsForThisPage = baseQuestionsPerPage + (i < extraQuestions ? 1 : 0);
      
      if (page && typeof page === 'string' && page.trim().length > 50 && questionsForThisPage > 0) {
        batches.push({
          content: page,
          questions: questionsForThisPage,
          pageInfo: `Page ${i + 1}/${pages.length}`
        });
      }
    }
    
    // Verify total questions match requested
    const totalPlanned = batches.reduce((sum, b) => sum + b.questions, 0);
    console.log(`Distribution: ${batches.map(b => b.questions).join(', ')} = ${totalPlanned} MCQs across ${pages.length} pages`);
    
    if (batches.length === 0) {
      setError('Could not create processing batches.');
      return [];
    }

    console.log(`Created ${batches.length} batches with EQUAL page weightage to generate ${numQuestions} MCQs`);
    setStatus(`⚡ Generating ${numQuestions} ${difficulty.toUpperCase()} MCQs with EQUAL distribution across ${pages.length} pages...`);

    const allMcqs: MCQ[] = [];
    const existingQuestions = new Set<string>();
    
    // Process SEQUENTIALLY with smart key rotation
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      
      // Check available keys
      const availableKeys = getAvailableKeyCount();
      if (availableKeys === 0) {
        setStatus('⏳ All keys cooling down. Waiting 30s for recovery...');
        await new Promise(r => setTimeout(r, 30000));
        
        // Check again after wait
        if (getAvailableKeyCount() === 0) {
          setError('⚠️ All API keys are rate limited. Please wait a few minutes and try again.');
          break;
        }
      }
      
      setStatus(`📝 ${batch.pageInfo}: Generating ${batch.questions} MCQs (${allMcqs.length}/${numQuestions} total) [${availableKeys}/20 keys ready]...`);
      
      const result = await generateMCQsBatch(batch.content, batch.questions, i + 1, batches.length, batch.pageInfo, setStatus, difficulty);
      
      // Add unique MCQs with validation
      if (result && Array.isArray(result)) {
        for (const mcq of result) {
          if (!mcq || typeof mcq !== 'object') continue;
          if (!mcq.question || typeof mcq.question !== 'string') continue;
          if (!mcq.options || !Array.isArray(mcq.options) || mcq.options.length !== 4) continue;
          if (!mcq.correct) continue;
          
          const key = normalizeQuestion(mcq.question);
          if (key && key.length > 5 && !existingQuestions.has(key)) {
            allMcqs.push(mcq);
            existingQuestions.add(key);
          }
        }
      }
      
      // Progress update
      const progressPct = Math.min(100, Math.round((allMcqs.length / numQuestions) * 100));
      setStatus(`📊 Generated ${allMcqs.length}/${numQuestions} MCQs (${progressPct}%)...`);
      
      // Early exit if we have enough
      if (allMcqs.length >= numQuestions) {
        break;
      }
      
      // Smart delay between batches - shorter with more available keys
      if (i < batches.length - 1) {
        const delayMs = Math.max(2000, 8000 - (getAvailableKeyCount() * 800)); // 2s-8s based on key availability
        setStatus(`⏳ Rotating keys... next batch in ${Math.round(delayMs/1000)}s`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    // If still short, try gap-filling with smart key recovery
    let attempts = 0;
    const maxAttempts = 5;
    
    while (allMcqs.length < numQuestions * 0.9 && attempts < maxAttempts && pages.length > 0) {
      // Wait for keys to recover if needed
      const availableKeys = getAvailableKeyCount();
      if (availableKeys === 0) {
        setStatus('⏳ Keys recovering... waiting 20s');
        await new Promise(r => setTimeout(r, 20000));
        if (getAvailableKeyCount() === 0) {
          setError(`⚠️ Generated ${allMcqs.length}/${numQuestions} MCQs. Keys need more time to recover.`);
          break;
        }
      }
      
      attempts++;
      const shortfall = numQuestions - allMcqs.length;
      setStatus(`📊 Gap-filling: need ${shortfall} more MCQs (attempt ${attempts}/${maxAttempts}) [${getAvailableKeyCount()}/10 keys]...`);
      
      await new Promise(r => setTimeout(r, 3000)); // Short delay between gap-fill attempts
      
      const pageIndex = attempts % pages.length;
      const page = pages[pageIndex];
      
      if (page && typeof page === 'string' && page.trim().length > 100) {
        const questionsNeeded = Math.min(15, shortfall);
        const result = await generateMCQsBatch(page, questionsNeeded, attempts, maxAttempts, `Page ${pageIndex + 1} (gap-fill)`, setStatus, difficulty);
        
        if (result && Array.isArray(result)) {
          for (const mcq of result) {
            if (!mcq || typeof mcq !== 'object') continue;
            if (!mcq.question || typeof mcq.question !== 'string') continue;
            if (!mcq.options || !Array.isArray(mcq.options) || mcq.options.length !== 4) continue;
            if (!mcq.correct) continue;
            
            const key = normalizeQuestion(mcq.question);
            if (key && key.length > 5 && !existingQuestions.has(key)) {
              allMcqs.push(mcq);
              existingQuestions.add(key);
              if (allMcqs.length >= numQuestions) break;
            }
          }
        }
      }
    }

    const finalCount = Math.min(allMcqs.length, numQuestions);
    if (finalCount === 0) {
      setError('❌ Could not generate MCQs. All API keys may be rate limited. Please try again later.');
    } else {
      setStatus(`✅ Generated ${finalCount} unique MCQs`);
    }
    return allMcqs.slice(0, numQuestions);
  };

  const parseMCQs = (text: string): MCQ[] => {
    if (!text || typeof text !== 'string') return [];
    
    const questions: MCQ[] = [];
    // Handle both "Q1." and "Q1)" and "1." formats
    const qBlocks = text.split(/(?=(?:Q\d+[\.\)]|\b\d+[\.\)]\s+))/i).filter(b => b && b.trim());
    
    for (const block of qBlocks) {
      if (!block) continue;
      const lines = block.split('\n').map(l => (l || '').trim()).filter(Boolean);
      if (lines.length < 5) continue;
      
      const mcq: MCQ = {
        question: '',
        options: [],
        correct: '',
        explanation: '',
        selected: null
      };
      
      let inExplanation = false;
      let explanationLines: string[] = [];
      
      for (const line of lines) {
        if (!line) continue;
        
        // Parse question number and text (Q1. / Q1) / 1. formats)
        if (/^(?:Q?\d+[\.\)])\s+/i.test(line) && !mcq.question) {
          mcq.question = line.replace(/^(?:Q?\d+[\.\)])\s*/i, '').trim();
          inExplanation = false;
        } 
        // Parse options A-D (formats: "A." "A)" "(A)" "a." "a)")
        else if (/^[\(\s]*[A-Da-d][\.\)\:](?:\s|$)/i.test(line) && mcq.options.length < 4 && !inExplanation) {
          const cleaned = line.replace(/^[\(\s]*([A-Da-d])[\.\)\:]\s*/, '$1. ').trim();
          mcq.options.push(cleaned);
        } 
        // Parse correct answer (multiple formats)
        else if (/^(?:Correct\s*Answer|Answer|Ans)\s*[:\-]/i.test(line)) {
          const match = line.match(/\b([A-Da-d])\b/i);
          mcq.correct = match ? match[1].toLowerCase() : '';
          inExplanation = false;
        } 
        // Parse explanation
        else if (/^Explanation/i.test(line)) {
          const expText = line.replace(/^Explanation[^:]*:\s*/i, '').trim();
          if (expText) explanationLines.push(expText);
          inExplanation = true;
        } 
        // Continue explanation on next lines
        else if (inExplanation) {
          explanationLines.push(line);
        } 
        // Continue question text if no options yet
        else if (mcq.question && mcq.options.length === 0) {
          mcq.question += ' ' + line;
        }
      }
      
      mcq.explanation = explanationLines.join(' ').trim();
      
      // Validate correct answer
      if (mcq.correct && !['a', 'b', 'c', 'd'].includes(mcq.correct)) {
        // Try to extract from explanation if answer letter is mentioned
        const expMatch = mcq.explanation.match(/correct\s+(?:answer|option)\s+is\s+[\(\s]*([A-Da-d])/i);
        mcq.correct = expMatch ? expMatch[1].toLowerCase() : 'a';
      }
      
      // Accept questions with valid structure
      if (mcq.question && mcq.question.trim().length > 10 && mcq.options.length === 4 && mcq.correct) {
        questions.push(mcq);
      } else if (mcq.question && mcq.options.length === 4 && !mcq.correct && mcq.explanation) {
        // Try to recover correct answer from explanation
        const expMatch = mcq.explanation.match(/\b([A-Da-d])\b.*(?:is correct|correct answer)/i);
        if (expMatch) {
          mcq.correct = expMatch[1].toLowerCase();
          questions.push(mcq);
        }
      }
    }
    
    return questions;
  };

  const handleProcess = async () => {
    const file = fileInputRef.current?.files?.[0];
    
    if (!pdfLibLoaded) {
      setError('PDF library loading. Please wait and retry.');
      return;
    }
    
    if (!file) {
      setError('Please upload a PDF file');
      return;
    }
    
    if (!count || count < 1 || count > 500) {
      setError('Enter valid number (1-500)');
      return;
    }
    
    setProcessing(true);
    setError('');
    setStatus('Loading PDF...');
    setProgress({ current: 0, total: 0, speed: 0, elapsed: 0 });
    
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await window.pdfjsLib.getDocument({
        data: arrayBuffer,
        cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/cmaps/',
        cMapPacked: true
      }).promise;
      
      setStatus(`Processing ${pdf.numPages} pages...`);
      const content = await processPDFOptimized(pdf);
      
      setStatus('Generating MCQs...');
      const generatedMCQs = await generateMCQs(content, count);
      
      setStatus('');
      // Navigate to quiz page with generated MCQs
      navigate('/quiz', { state: { mcqs: generatedMCQs } });
    } catch (err: any) {
      setError(`Error: ${err.message}`);
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-900 via-indigo-900 to-purple-900 p-4">
      <div className="max-w-4xl mx-auto bg-white rounded-2xl shadow-2xl p-8 my-8">
        <div className="text-center mb-6">
          <div className="inline-block bg-gradient-to-r from-cyan-500 to-blue-600 text-white px-6 py-2 rounded-full text-sm font-bold mb-4 shadow-lg">
            🚀 {totalKeys > 0 ? `${totalKeys} API KEYS` : 'ADD API KEYS'} • SMART ROTATION • AUTO RECOVERY
          </div>
          <h1 className="text-4xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent mb-2">
            ⚡ SSC MCQ Generator Ultra
          </h1>
          <p className="text-gray-600 text-sm">Upload PDF → Generate SSC-level MCQs</p>
          {!pdfLibLoaded && (
            <p className="text-sm text-amber-600 mt-2 animate-pulse">⏳ Loading PDF engine...</p>
          )}
        </div>

        {/* Bulk API Key Manager */}
        <div className="mb-6">
          <BulkApiKeyManager />

          {/* API key help text */}
          <div className="mt-4 rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/5 to-accent/5 p-5 shadow-sm">
            <div className="flex items-start gap-3 mb-3">
              <span className="text-2xl">🔑</span>
              <div>
                <p className="text-foreground font-bold text-base">API Keys Required</p>
                <p className="text-muted-foreground text-sm mt-0.5">
                  Add your own Google Gemini API keys to generate MCQs.
                </p>
              </div>
            </div>
            <div className="bg-background/60 backdrop-blur-sm p-4 rounded-xl border border-border/50">
              <p className="font-semibold text-foreground text-sm mb-2.5 flex items-center gap-1.5">
                <span className="text-primary">✦</span> How to get free API keys:
              </p>
              <ol className="text-sm text-muted-foreground list-decimal list-inside space-y-1.5">
                <li>
                  Go to{' '}
                  <a
                    href="https://aistudio.google.com/apikey"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline font-semibold"
                  >
                    Google AI Studio ↗
                  </a>
                </li>
                <li>Sign in with your Google account</li>
                <li>Click <span className="font-medium text-foreground">"Create API Key"</span></li>
                <li>Copy &amp; paste it in the API Key Manager above</li>
              </ol>
            </div>
          </div>
        </div>

        {/* User Manual */}
        <div className="mb-6">
          <UserManual />
        </div>


        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-gray-700 font-semibold mb-2">🎯 Difficulty Level</label>
            <select 
              value={difficulty} 
              onChange={(e) => setDifficulty(e.target.value)}
              className="w-full p-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none transition-colors"
              disabled={processing || !pdfLibLoaded}
            >
              <option value="hard+easy">Hard + Easy (Recommended)</option>
              <option value="hard">Hard Only</option>
              <option value="easy">Easy Only</option>
            </select>
          </div>
          
          <div>
            <label className="block text-gray-700 font-semibold mb-2">🔢 Number of MCQs</label>
            <div className="relative">
              <input
                type="number" 
                value={count || ''}
                onChange={(e) => {
                  const val = e.target.value === '' ? 0 : parseInt(e.target.value);
                  if (!isNaN(val)) setCount(Math.min(500, val));
                }}
                onBlur={() => {
                  if (count < 1) setCount(1);
                }}
                min="1"
                max="500"
                placeholder="Enter 1-500"
                className="w-full p-3 pr-16 text-lg font-semibold border-2 border-gray-300 rounded-xl focus:border-blue-500 focus:ring-2 focus:ring-blue-200 focus:outline-none transition-all disabled:bg-gray-100 disabled:text-gray-500"
                disabled={processing || !pdfLibLoaded || autoCount}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 font-medium">
                MCQs
              </span>
            </div>
            {/* Quick preset buttons */}
            <div className="flex gap-2 mt-2 flex-wrap">
              {[10, 25, 50, 100, 200].map(preset => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => { setAutoCount(false); setCount(preset); }}
                  disabled={processing || !pdfLibLoaded}
                  className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-all ${
                    count === preset && !autoCount
                      ? 'bg-blue-600 text-white shadow-md'
                      : 'bg-gray-100 text-gray-600 hover:bg-blue-100 hover:text-blue-700'
                  } disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Auto Coverage Option */}
        <div className="mb-4 p-4 bg-gradient-to-r from-green-50 to-emerald-50 border-2 border-green-300 rounded-xl">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={autoCount}
              onChange={(e) => {
                setAutoCount(e.target.checked);
                if (!e.target.checked) {
                  setEstimatedCount(0);
                } else if (fileInputRef.current?.files?.[0]) {
                  // Re-estimate if file already selected
                  setStatus('📊 Deep analyzing PDF content...');
                  const file = fileInputRef.current.files[0];
                  estimateMCQCount(file).then(est => {
                    setEstimatedCount(est);
                    setCount(est);
                    setStatus('');
                  });
                }
              }}
              className="w-5 h-5 accent-green-600"
              disabled={processing || !pdfLibLoaded}
            />
            <div>
              <span className="font-bold text-green-800">🎯 Auto Coverage Mode (RECOMMENDED)</span>
              <p className="text-sm text-green-700">Deep analyzes PDF to calculate exact MCQs needed for 100% content coverage</p>
            </div>
          </label>
          {autoCount && estimatedCount > 0 && (
            <div className="mt-2 ml-8">
              <div className="text-sm font-semibold text-green-800 bg-green-100 px-3 py-2 rounded-lg inline-block">
                📊 Analysis Complete: <span className="text-lg">{estimatedCount}</span> MCQs required for FULL PDF coverage
              </div>
              <p className="text-xs text-green-600 mt-1 ml-1">Based on word count, fact density & page analysis</p>
            </div>
          )}
        </div>

        <div className="mb-6">
          <label className="block text-gray-700 font-semibold mb-2">📄 Upload PDF</label>
          <input 
            type="file" 
            ref={fileInputRef}
            accept=".pdf"
            onChange={handleFileChange}
            className="w-full p-3 border-2 border-gray-300 rounded-lg bg-gray-50 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
            disabled={processing || !pdfLibLoaded}
          />
        </div>

        {/* Real-time API Key Status Panel */}
        {processing && (
          <div className="mb-4 p-4 bg-gradient-to-br from-slate-800 to-slate-900 rounded-xl shadow-lg">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-white font-bold text-sm">🔑 API Key Status (Real-time)</h3>
              <div className="flex gap-4 text-xs">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse"></span>
                  <span className="text-green-400">Active</span>
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-gray-400"></span>
                  <span className="text-gray-400">Idle</span>
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-amber-400"></span>
                  <span className="text-amber-400">Recovering</span>
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-red-500"></span>
                  <span className="text-red-400">Rate Limited</span>
                </span>
              </div>
            </div>
            <div className="grid grid-cols-10 gap-2">
              {keyStatuses.map((key) => (
                <div
                  key={key.index}
                  className={`relative p-2 rounded-lg text-center transition-all duration-300 ${
                    key.status === 'active'
                      ? 'bg-green-500/20 border-2 border-green-400 shadow-lg shadow-green-500/30'
                      : key.status === 'recovering'
                      ? 'bg-amber-500/20 border-2 border-amber-400'
                      : key.status === 'rate-limited'
                      ? 'bg-red-500/20 border-2 border-red-500'
                      : 'bg-gray-700/50 border border-gray-600'
                  }`}
                >
                  <div className={`text-xs font-bold ${
                    key.status === 'active' ? 'text-green-400' :
                    key.status === 'recovering' ? 'text-amber-400' :
                    key.status === 'rate-limited' ? 'text-red-400' :
                    'text-gray-400'
                  }`}>
                    K{key.index + 1}
                  </div>
                  <div className="text-[10px] text-gray-400 mt-0.5">
                    {key.requestCount} req
                  </div>
                  {key.status === 'recovering' && (
                    <div className="absolute bottom-0 left-0 right-0 h-1 bg-gray-700 rounded-b-lg overflow-hidden">
                      <div 
                        className="h-full bg-amber-400 transition-all duration-500"
                        style={{ width: `${key.recoveryProgress}%` }}
                      ></div>
                    </div>
                  )}
                  {key.status === 'active' && (
                    <div className="absolute -top-1 -right-1 w-3 h-3 bg-green-400 rounded-full animate-ping"></div>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-3 flex justify-between text-xs text-gray-400">
              <span>Available: {keyStatuses.filter(k => k.status !== 'rate-limited' && k.status !== 'recovering').length}/20</span>
              <span>Total Requests: {keyStatuses.reduce((sum, k) => sum + k.requestCount, 0)}</span>
            </div>
          </div>
        )}


        {/* Donation Button */}
        <div className="flex justify-center mb-6">
          <DonationButton pauseAnimation={processing} />
        </div>

        <button 
          onClick={handleProcess}
          disabled={processing || !pdfLibLoaded}
          className={`w-full py-4 rounded-lg text-white font-bold text-lg transition-all ${
            processing || !pdfLibLoaded
              ? 'bg-gray-400 cursor-not-allowed' 
              : 'bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 shadow-lg hover:shadow-xl transform hover:-translate-y-1'
          }`}
        >
          {processing ? '⚡ Processing...' : !pdfLibLoaded ? '⏳ Loading...' : '🚀 Start Ultra-Fast Processing'}
        </button>

        {error && (
          <div className="mt-6 bg-red-50 border-l-4 border-red-500 text-red-700 px-4 py-3 rounded-lg">
            ❌ {error}
          </div>
        )}

        {status && (
          <div className="mt-6 text-center">
            <p className="text-lg font-semibold text-blue-600 animate-pulse">{status}</p>
          </div>
        )}

        {progress.total > 0 && (
          <div className="mt-6 bg-gradient-to-br from-gray-50 to-blue-50 p-6 rounded-lg shadow-inner">
            <h3 className="text-xl font-bold text-blue-600 mb-4">📊 Live Progress</h3>
            <p className="text-3xl font-bold text-center mb-4 text-gray-800">{progress.current}/{progress.total} pages</p>
            
            <div className="w-full bg-gray-300 rounded-full h-10 mb-4 overflow-hidden shadow-inner">
              <div 
                className="bg-gradient-to-r from-cyan-500 via-blue-500 to-purple-600 h-full rounded-full flex items-center justify-center text-white font-bold transition-all duration-500 shadow-lg"
                style={{ width: `${(progress.current / progress.total) * 100}%` }}
              >
                {Math.round((progress.current / progress.total) * 100)}%
              </div>
            </div>
            
            <div className="grid grid-cols-3 gap-4 text-center">
              <div className="bg-white p-4 rounded-lg shadow-md border-t-4 border-green-500">
                <p className="text-3xl font-bold text-green-600">{progress.current}</p>
                <p className="text-sm text-gray-600 font-medium">✅ Done</p>
              </div>
              <div className="bg-white p-4 rounded-lg shadow-md border-t-4 border-amber-500">
                <p className="text-3xl font-bold text-amber-600">{progress.total - progress.current}</p>
                <p className="text-sm text-gray-600 font-medium">⚡ Left</p>
              </div>
              <div className="bg-white p-4 rounded-lg shadow-md border-t-4 border-blue-500">
                <p className="text-3xl font-bold text-blue-600">{progress.speed}</p>
                <p className="text-sm text-gray-600 font-medium">📊 pg/min</p>
              </div>
            </div>
            
            <p className="text-center mt-4 text-lg font-semibold text-gray-700">
              ⏱️ Time: {Math.floor(progress.elapsed / 60)}m {progress.elapsed % 60}s
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default SSCMCQGenerator;
