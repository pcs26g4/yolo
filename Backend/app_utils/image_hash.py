"""
Image Hashing Utilities
Provides functions for calculating and comparing image hashes for deduplication.
Uses perceptual hashing (pHash) to detect similar images even with slight variations.
"""
import hashlib
from io import BytesIO
from typing import Optional

try:
    import imagehash
    from PIL import Image
    IMAGEHASH_AVAILABLE = True
except ImportError:
    IMAGEHASH_AVAILABLE = False
    Image = None
    imagehash = None


def calculate_perceptual_hash(image_bytes: bytes) -> Optional[str]:
    """
    Calculate perceptual hash (pHash) for an image.
    This hash is robust to minor variations (compression, resizing, etc.)
    
    Args:
        image_bytes: Image file bytes
        
    Returns:
        Hex string representation of the hash, or None if calculation fails
    """
    if not IMAGEHASH_AVAILABLE:
        # Fallback to MD5 if imagehash is not available
        return calculate_md5_hash(image_bytes)
    
    try:
        img = Image.open(BytesIO(image_bytes))
        # Convert to RGB if necessary (handles RGBA, P, etc.)
        if img.mode != 'RGB':
            img = img.convert('RGB')
        
        # Calculate perceptual hash (8x8 = 64 bits)
        phash = imagehash.phash(img, hash_size=8)
        return str(phash)
    except Exception as e:
        # Fallback to MD5 on error
        return calculate_md5_hash(image_bytes)


def calculate_md5_hash(image_bytes: bytes) -> str:
    """
    Calculate MD5 hash for exact duplicate detection.
    
    Args:
        image_bytes: Image file bytes
        
    Returns:
        Hex string representation of the MD5 hash
    """
    return hashlib.md5(image_bytes).hexdigest()


def compare_image_hashes(hash1: Optional[str], hash2: Optional[str], threshold: int = 5) -> bool:
    """
    Compare two perceptual hashes to determine if images are similar.
    
    Args:
        hash1: First image hash (hex string)
        hash2: Second image hash (hex string)
        threshold: Maximum Hamming distance to consider images similar (default: 5)
                  Lower values = stricter matching
        
    Returns:
        True if images are similar (within threshold), False otherwise
    """
    if not hash1 or not hash2:
        return False
    
    # If hashes are MD5 (64 chars), do exact comparison
    if len(hash1) == 32 and len(hash2) == 32:
        return hash1 == hash2
    
    # For perceptual hashes, calculate Hamming distance
    try:
        if IMAGEHASH_AVAILABLE:
            h1 = imagehash.hex_to_hash(hash1)
            h2 = imagehash.hex_to_hash(hash2)
            distance = h1 - h2  # Hamming distance
            return distance <= threshold
        else:
            # Fallback: exact match for MD5
            return hash1 == hash2
    except Exception:
        # Fallback: exact match
        return hash1 == hash2


def calculate_image_hash(image_bytes: bytes, use_perceptual: bool = True) -> str:
    """
    Calculate hash for an image (perceptual or MD5).
    
    Args:
        image_bytes: Image file bytes
        use_perceptual: If True, use perceptual hash; if False, use MD5
        
    Returns:
        Hex string representation of the hash
    """
    if use_perceptual:
        phash = calculate_perceptual_hash(image_bytes)
        if phash:
            return phash
        # Fallback to MD5 if perceptual hash fails
        return calculate_md5_hash(image_bytes)
    else:
        return calculate_md5_hash(image_bytes)

